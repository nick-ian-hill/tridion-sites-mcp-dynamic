import { z } from "zod";
import * as vm from 'vm';
import { formatForAgent, formatForApi } from "../utils/fieldReordering.js";
import { convertItemIdToContextPublication } from "../utils/convertItemIdToContextPublication.js";

// --- Security Configuration ---
/**
 * Defines the maximum time a script's synchronous code can run.
 * This prevents `while(true)` loops from blocking the thread.
 */
const SYNC_SCRIPT_TIMEOUT_MS = 5000; // 5 seconds

/**
 * Defines the maximum total time an async script can run (including awaiting tools).
 * This prevents runaway scripts or long-running operations.
 */
const TOTAL_SCRIPT_TIMEOUT_MS = 600000; // 10 minutes

/**
 * A strict deny-list of tool names that *cannot* be passed to the sandboxed script.
 */
const DISALLOWED_TOOLS: string[] = [
    "toolOrchestrator",
];

/**
 * Creates the base "clean-room" sandbox for running a script.
 * It has no access to Node.js globals (process, require) or Object.prototype.
 */
const createBaseSandbox = (): any => {
    const sandbox = Object.create(null);
    // Add back safe, standard JS globals
    sandbox.Object = Object;
    sandbox.Array = Array;
    sandbox.String = String;
    sandbox.Number = Number;
    sandbox.Boolean = Boolean;
    sandbox.JSON = JSON;
    sandbox.Promise = Promise;
    sandbox.Error = Error;
    sandbox.RegExp = RegExp;
    sandbox.Date = Date;
    sandbox.Math = Math;
    sandbox.Map = Map;
    sandbox.Set = Set;
    sandbox.URL = URL;
    sandbox.URLSearchParams = URLSearchParams;
    // Common Error types
    sandbox.TypeError = TypeError;
    sandbox.SyntaxError = SyntaxError;
    sandbox.RangeError = RangeError;
    sandbox.ReferenceError = ReferenceError;
    return sandbox;
};
// --- End Security Configuration ---

/**
 * Recursively adds a non-enumerable 'itemId' getter to any object that has an 'Id'.
 * Being non-enumerable means the agent can read it, but it won't be serialized 
 * and sent to the API, preventing 400 Bad Request errors.
 */
function applyItemIdAlias(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) applyItemIdAlias(obj[i]);
        return obj;
    }

    if ('Id' in obj && !('itemId' in obj)) {
        Object.defineProperty(obj, 'itemId', {
            get: function () { return this.Id; },
            enumerable: false,
            configurable: true
        });
    }

    for (const key of Object.keys(obj)) applyItemIdAlias(obj[key]);

    return obj;
}

// --- Utilities for Scripts ---

const scriptUtils = {
    /** Converts an item ID to match a specific publication context.
        Returns the string ID directly. */
    convertItemIdToContextPublication,

    /**
     * Throws an error if the condition is false.
     * Useful for validation within scripts.
     */
    assert: (condition: boolean, message?: string) => {
        if (!condition) {
            throw new Error(message || "Assertion failed");
        }
    },

    /**
     * Returns a random sample of items from an array.
     * Useful for auditing a subset of results.
     */
    sample: <T>(array: T[], size: number): T[] => {
        if (!Array.isArray(array)) return [];
        if (size <= 0) return [];
        const shuffled = array.slice().sort(() => 0.5 - Math.random());
        return shuffled.slice(0, size);
    }
};

/**
 * Scans continuous script strings for any calls to `context.tools.<ToolName>`
 * or `context.tools['<ToolName>']` and returns a set of unique tool names used.
 */
function scanForRequiredTools(scripts: (string | undefined)[]): Set<string> {
    const toolsUsed = new Set<string>();
    // Matches context.tools.toolName and context.tools['toolName'] or context.tools["toolName"]
    const dotPropRegex = /context\.tools\.([a-zA-Z0-9_]+)/g;
    const bracketPropRegex = /context\.tools\[['"]([^'"]+)['"]\]/g;

    for (const script of scripts) {
        if (!script) continue;

        let match;
        // Dot notation matches
        while ((match = dotPropRegex.exec(script)) !== null) {
            if (match[1]) toolsUsed.add(match[1]);
        }
        // Reset regex index
        dotPropRegex.lastIndex = 0;

        // Bracket notation matches
        while ((match = bracketPropRegex.exec(script)) !== null) {
            if (match[1]) toolsUsed.add(match[1]);
        }
        // Reset regex index
        bracketPropRegex.lastIndex = 0;
    }
    return toolsUsed;
}

// --- Interfaces ---

// Define the shape of the context object for the pre-processing script.
interface PreScriptContext {
    /** The JSON object passed to the 'parameters' input of the toolOrchestrator tool. */
    parameters: Record<string, any>;
    /** A dictionary of all available tools, wrapped for execution. */
    tools: { [toolName: string]: (args: any) => Promise<any> };
    /** A set of synchronous utility functions. */
    utils: typeof scriptUtils;
    /** A function to log messages, which will be included in the final summary. */
    log: (message: string) => void;
}

// Define the shape of the context object for the main 'map' script.
interface MapScriptContext {
    /** The TCM URI of the item currently being processed in the loop. */
    currentItemId: string;
    /** The JSON object passed to the 'parameters' input of the toolOrchestrator tool. */
    parameters: Record<string, any>;
    /** The 'preProcessingResult' object returned by the 'preProcessingScript' (if any). */
    preProcessingResult: any;
    /** A dictionary of all available tools, wrapped for execution. */
    tools: { [toolName: string]: (args: any) => Promise<any> };
    /** A set of synchronous utility functions. */
    utils: typeof scriptUtils;
    /** A function to log messages, which will be included in the final summary. */
    log: (message: string) => void;
}

/**
 * The structured result returned by the orchestrator.
 * This structure ensures the agent always knows the state of the operation,
 * even if it stopped midway.
 */
interface OrchestratorResult {
    status: "Completed" | "StoppedOnError" | "PartialSuccess";
    summary: string;
    /** List of items that were successfully processed before any stop/completion. */
    processedItems: Array<{ id: string, result: any }>;
    /** The specific item that caused the stop (if stopOnError was true). */
    failedItem?: { id: string, error: string };
    /** The final output data (from postProcessingScript or default summary). */
    output?: any;
    /** The optional execution log, included if debug is true. */
    executionLog?: string;
}

// This plain object defines the input properties, matching your other tools
const toolOrchestratorInputProperties = {
    itemIds: z.array(z.string())
        .optional()
        .describe("An optional array of unique IDs or string keys to be processed. If you already found IDs in a previous 'Discovery' turn, pass them directly here for Turn 2 so you do not need to rewrite your preProcessingScript filtering logic."),
    preProcessingScript: z.string().optional()
        .describe("Phase 1 (Setup): An optional async function body that runs once before the loop. Must return `string[]` (item IDs) or `{ itemIds: string[], preProcessingResult?: any }`. Use this for dynamic discovery (e.g. `search`) or setup."),
    mapScript: z.string().optional()
        .describe("Phase 2 (Map): An optional async function body that runs for EACH item. If omitted, the orchestrator will gracefully exit after Phase 1 and return the discovered items (perfect for Discovery/Turn 1). CRITICAL: To prevent silent failures, if a required lookup fails or an update is impossible, you MUST `throw new Error('Reason')`."),
    postProcessingScript: z.string().optional()
        .describe("Phase 3 (Reduce): An optional async function body that runs once after all items are processed. Has access to `context.results`, `context.successes`, `context.warnings`, and `context.failures`. Returns the final output."),
    parameters: z.record(z.any()).optional()
        .describe("An optional JSON object of parameters to pass into all scripts. Use this for simple, static values like search queries, find/replace strings, or target TCM URIs."),
    forceSkipIfPresent: z.boolean().optional().default(false)
        .describe("If true, any '409 Conflict' (Item Already Exists) error during creation is treated as an immediate Success without checking if the item properties match."),
    stopOnError: z.boolean().optional().default(true)
        .describe("If true (default), the entire operation stops if any single item fails during the 'map' phase. If false, it logs the error and continues to the next item."),
    maxConcurrency: z.number().int().min(1).max(10).optional().default(5)
        .describe("The maximum number of 'map' scripts to run in parallel. Set to 1 for sequential execution."),
    includeScriptResults: z.boolean().optional().default(false)
        .describe("Controls whether the final output includes the individual results from the 'mapScript'. Defaults to false to save tokens."),
    debug: z.boolean().optional().default(false)
        .describe("If true, the full execution log is included in the JSON response.")
};

const toolOrchestratorSchema = z.object(toolOrchestratorInputProperties);

export const toolOrchestrator = {
    name: "toolOrchestrator",
    summary: "Executes custom JavaScript scripts for batch operations and complex CMS workflows.",
    description: `Executes an advanced, multi-step JavaScript script to perform batch operations, aggregations, or complex workflows.
    The tool supports up to three phases. (Note: If 'mapScript' is omitted, the orchestrator acts in "Discovery-Only" mode. It will execute Phase 1, return the discovered items, and skip Phases 2 and 3):
    1.  Setup (preProcessingScript): Dynamically find items (e.g., via 'search') or prepare data.
    2.  Map (mapScript): Optional. Process each item individually (e.g., 'updateContent', 'getItem'). MUST fail loudly using throws on errors.
    3.  Reduce (postProcessingScript): Optional. Aggregate results or generate a summary.

    --- PARTIAL SUCCESS & ERROR HANDLING ---
    This tool implements specific logic for handling failures:
    - StopOnError = true (Default): The tool stops immediately upon the first error. It returns a "StoppedOnError" status, a list of all items successfully processed *before* the crash, and the specific error details. You should use this data to fix the issue and RESUME operation from the next item.
    - StopOnError = false: The tool attempts to process all items. Failures are recorded in the final "PartialSuccess" report.

    --- CRITICAL RULES FOR SUCCESS ---
    
    1. The Definition of Success vs. Failure
    The orchestrator marks an item as "Success" if the 'mapScript' runs without throwing an Error.
    - If your script returns \`null\`, \`false\`, or \`{ status: "Skipped" }\`, this counts as SUCCESS in the final summary.
    - TO FLAG A FAILURE: You MUST \`throw new Error("Reason")\`.
    - TO FLAG A WARNING: Use \`console.warn("Reason")\`. This will add the item to the 'warnings' count.

    2. "Fail Loudly" & Read-After-Write (Strong Validation)
    Do not assume the operation worked just because an update tool was called.
    Validate *inside* your 'mapScript' immediately after mutating data:
    - Update the item: \`await context.tools.updateContent({ itemId: context.currentItemId, ... })\`
    - Fetch the FRESH item: \`const freshItem = await context.tools.getItem({ itemId: context.currentItemId, ... })\`.
    - Assert the state: \`context.utils.assert(freshItem.Content.someField === "expected", "Update failed to persist")\`.
    
    3. "Find-Then-Fetch" Pattern
    Discovery tools (like 'search', 'getItemsInContainer') ONLY return identification data (Id, Title, type).
    To inspect properties (Metadata, Content), you MUST:
    - Find: Use 'search' in 'preProcessingScript' to get IDs.
    - Fetch: Use 'mapScript' to call 'getItem' for specific details.

    4. Idempotency (Creation Tools)
    If you use creation tools (createItem, createPage, etc.) and the item already exists:
    - DEFAULT: The tool will FAIL with a "409 Conflict" error.
    - OPTIONAL: Set 'forceSkipIfPresent: true' in the parameters. The tool will NOT fail; instead, it will skip the item and mark it as "Success (Skipped)".
    - Note: This skip is "blind". It does not check if the existing item matches your input.

    5. Defensive Execution & Failure Tracking
    CMS operations can fail for various business-logic reasons (e.g., items are locked, shared/unlocalized, in use by other items, or lacking mandatory fields). 
    - You MUST write defensive 'mapScripts' that anticipate and handle these realities.
    - Wrap risky operations (like 'updateContent', 'deleteItem', etc.) in 'try/catch' blocks or check their prerequisites if known.
    - Do not just look for "409 Conflict" (Item Exists) errors. If you catch a "400 Bad Request" validation error (e.g., trying to map to a Region or Field that does not exist), you MUST log the specific 'e.message' or 'e.response.data using 'context.log()'. This exposes the exact schema mismatch to you so you can self-correct.
    - NEVER let a script silently swallow an error or return a generic success object if the underlying operation failed. All skipped or failed items must be tracked by throwing errors.

    6. Destructive Actions (The Two-Turn Deletion Pattern)
    You MUST NEVER execute a script that deletes items without explicit prior confirmation from the user. Because the orchestrator runs all scripts in a single execution, you must split bulk deletions into TWO distinct tool calls across two conversation turns:
    - TURN 1 (Discovery & Consent): Call 'toolOrchestrator' using ONLY a 'preProcessingScript' to find the items. Return the list to the chat and ask the user for confirmation to delete. 
    - TURN 2 (Execution): ONLY after the user explicitly replies with consent, make a SECOND call to 'toolOrchestrator'. Pass the confirmed IDs into 'itemIds', and use 'mapScript' to call 'context.tools.deleteItem'. You MUST explicitly pass 'confirmed: true' in your deleteItem tool call within the mapScript, otherwise the deletion will silently fail.

    7. Data-Driven Content Modeling & Pre-Flight Checks
    When importing data from external files (Excel, CSV, attachments) and creating corresponding Schemas or Templates:
    - Do not guess or assume standard fields or layouts (e.g., assuming a single "Main" region). You MUST thoroughly analyze the *entire* dataset first.
    - Check the data for references to specific metadata fields, category classifications, or Page Regions (e.g., "Sidebar", "Header", "Footer").
    - **Pre-flight Checks**: Before using 'mapScript' to assemble Pages or Components in bulk, verify that your target Schemas and Templates actually contain the exact fields and regions you intend to populate.

    --- SCRIPT CONTEXT DETAILS ---

    The 'preProcessingScript' receives a 'context' object with:
    - context.parameters: The JavaScript object passed to the 'parameters' input.
    - context.tools: A dictionary of all available tools (e.g., context.tools.search).
    - context.utils: Utilities like convertItemIdToContextPublication.
    - context.log(message): A function to log progress.
    Must return \`string[]\` (item IDs) or \`{ itemIds: string[], preProcessingResult?: any }\`.

    The 'mapScript' receives a 'context' object with:
    - context.currentItemId: The ID of the item currently being processed.
    - context.parameters: The JavaScript object passed to the 'parameters' input.
    - context.preProcessingResult: The live JavaScript object returned by the preProcessingScript (if any). No JSON.parse() is needed.
    - context.tools: A dictionary of all available tools.
    - context.utils: Utilities ('assert', 'sample', 'convertItemIdToContextPublication').
    - context.log(message): Logging function. 'console.warn()' marks the item as a Warning.

    The 'postProcessingScript' receives a 'context' object with:
    - context.results: The read-only array of all results from the 'map' phase.
    - context.successes: A pre-filtered array of all successful results.
    - context.warnings: A pre-filtered array of items marked with 'console.warn'.
    - context.failures: A pre-filtered array of all failed results.
    - context.parameters, context.preProcessingResult, context.tools, context.utils, context.log.

    --- STRATEGIES ---

    DEBUGGING STRATEGIES
    For any complex script, or if you get an error, follow this debugging process:
    1. Test on a Single Item: Do not run your script on 500 items at once. First, run it with a single, non-critical item (e.g.,'itemIds': ["tcm:5-100"]).
    2. Set 'maxConcurrency: 1': This makes the execution log sequential and easy to read.
    3. Set 'debug: true': This includes a streamlined execution log in the response.
    4. Set 'includeScriptResults: true': This reveals what your mapScript is actually returning.
    5. Inspect the Result: This single-item test will either succeed, proving your logic, or it will fail with a real error.
    
    ADVANCED RESILIENCE STRATEGIES
    1. Fail Loudly on Mutations: DO NOT wrap 'createItem', 'createPage', 'updateContent', or other data-altering API calls in 'try/catch' blocks that return null. You MUST let these errors throw naturally so the Orchestrator's 'stopOnError' circuit breaker catches them and reports the exact schema mismatch to you.
    2. Handling Heavy Data & Complex Tasks (Single-Call Pattern): Do not read entire Excel files or large JSON blobs directly into the chat context. Execute Setup, Map, and Reduce in a single toolOrchestrator call. Parse the file in 'preProcessingScript' and pass the extracted data to 'mapScript' via memory ('context.preProcessingResult') rather than outputting large lists of IDs to the chat and pasting them into a second tool call.

    NOTES
    - Automatic JSON parsing: All tools have their JSON string responses automatically parsed into JavaScript objects. You do not need to parse tool responses in a script.
    - Script Limits: All scripts are sandboxed. Sync code max 5s, Async max 600s.
    - Disallowed Tools: 'toolOrchestrator' cannot be called recursively.

`,
    examples: [
        {
            description: "Batch Search & Update with Read-After-Write Validation: Finds Components and updates a field. Validates *inside* the map loop.",
            payload: `const result = await tools.toolOrchestrator({
    parameters: { "schemaId": "tcm:5-20-8", "newValue": "Updated Value" },
    preProcessingScript: \`
        context.log('Phase 1: Finding items...');
        const items = await context.tools.search({
            searchQuery: { 
                ItemTypes: ["Component"], 
                BasedOnSchemas: [{ schemaUri: context.parameters.schemaId }],
                SearchIn: "tcm:0-5-1" 
            }
        });
        return items.map(i => i.Id);
    \`,
    mapScript: \`
        // Phase 2: Update the item
        await context.tools.updateContent({
            itemId: context.currentItemId,
            content: { "TextField": context.parameters.newValue }
        });
        
        // Read-After-Write Validation
        const freshItem = await context.tools.getItem({ 
            itemId: context.currentItemId,
            includeProperties: ["Content"]
        });
        const actualValue = freshItem.Content.TextField;
        context.utils.assert(
            actualValue === context.parameters.newValue, 
            \`Update Failed for \${context.currentItemId}. Expected '\${context.parameters.newValue}', got '\${actualValue}'\`
        );
        
        context.log("Updated and validated.");
        return { id: context.currentItemId };
    \`
});`
        },
        {
            description: "Data Aggregation: Finds the Component with the most versions.",
            payload: `const result = await tools.toolOrchestrator({
    itemIds: ["tcm:5-100", "tcm:5-101", "tcm:5-102"],
    mapScript: \`
        const history = await context.tools.getItemHistory({ itemId: context.currentItemId });
        return { id: context.currentItemId, count: history.length };
    \`,
    postProcessingScript: \`
        // Find max in context.successes
        if (context.successes.length === 0) throw new Error("No items processed.");
        return context.successes.reduce((max, curr) => 
            (curr.result.count > max.result.count) ? curr : max
        ).result;
    \`
});`
        },
        {
            description: "Handling Warnings (Silent Errors): Skips items that are checked out and marks them as warnings without failing the loop.",
            payload: `const result = await tools.toolOrchestrator({
    itemIds: ["tcm:5-100", "tcm:5-101"],
    mapScript: \`
        // Check lock status first
        const item = await context.tools.getItem({ itemId: context.currentItemId });
        if (item.LockInfo.LockType !== 'None') {
            // Use warning to flag this without failing the script
            console.warn(\`Skipping \${context.currentItemId} because it is locked by \${item.LockInfo.LockUser.Title}\`);
            return null;
        }
        
        // Perform update...
        return { id: context.currentItemId, status: "Updated" };
    \`
});`
        },
        {
            description: "Complex Analysis / Stale Content Report: Finds Pages, checks Publish status, and aggregates a report.",
            payload: `const result = await tools.toolOrchestrator({
    preProcessingScript: \`
        const items = await context.tools.getItemsInContainer({ 
            containerId: "tcm:0-5-1", itemTypes: ["Page"], recursive: true 
        });
        return items.map(i => i.Id);
    \`,
    mapScript: \`
        const item = await context.tools.getItem({ 
            itemId: context.currentItemId, 
            includeProperties: ["VersionInfo.RevisionDate", "Title"] 
        });

        const pubInfo = await context.tools.getPublishInfo({ itemId: context.currentItemId });
        
        if (!pubInfo || pubInfo.length === 0) {
            console.warn(\`Skipped \${context.currentItemId}: Not published\`);
            return null;
        }
        
        // Check if stale...
        return { id: item.Id, title: item.Title, status: "Stale" };
    \`,
    postProcessingScript: \`
        return { 
            stalePages: context.successes.map(s => s.result).filter(r => r !== null),
            skippedCount: context.warnings.length 
        };
    \`
});`
        },
        {
            description: "Import with Validation: Imports data, creates items, and validates creation immediately.",
            payload: `const result = await tools.toolOrchestrator({
    parameters: { 
        "data": [{ "title": "Page 1", "file": "p1.html" }, { "title": "Page 2", "file": "p2.html" }] 
    },
    preProcessingScript: \`
        return {
            itemIds: context.parameters.data.map(d => d.title),
            preProcessingResult: { sourceData: context.parameters.data }
        };
    \`,
    mapScript: \`
        // Create Page logic here...
        // const newId = await context.tools.createPage(...);
        
        // Assert creation was successful (Fail Loudly)
        const check = await context.tools.getItem({ itemId: "tcm:5-99-64" }); // use newId in reality
        context.utils.assert(check, \`Item creation failed for \${context.currentItemId}\`);
        
        return { title: context.currentItemId, status: "Created", id: "tcm:5-99-64" };
    \`
});`
        },
        {
            description: "Compliance Report: Finds Pages published to Staging but not Live.",
            payload: `const result = await tools.toolOrchestrator({
    parameters: { "stagingId": "tcm:0-1-65537", "liveId": "tcm:0-2-65537" },
    preProcessingScript: \`
        const pages = await context.tools.getItemsInContainer({
           containerId: "tcm:0-5-1", itemTypes: ["Page"], recursive: true
        });
        return pages.map(p => p.Id);
    \`,
    mapScript: \`
        const info = await context.tools.getPublishInfo({ itemId: context.currentItemId });
        const onStaging = info.some(i => i.TargetType.IdRef === context.parameters.stagingId);
        const onLive = info.some(i => i.TargetType.IdRef === context.parameters.liveId);

        if (onStaging && !onLive) return { id: context.currentItemId, status: "Needs Live Publish" };
        return null;
    \`,
    postProcessingScript: \`
        // Reduce: Filter nulls and report
        return { itemsToReview: context.successes.map(s => s.result).filter(r => r !== null) };
    \`
});`
        },
        {
            description: "Advanced Cleanup - Large Unused Multimedia Report: Finds large Multimedia Components (images/videos) that are not used by any published Pages.",
            payload: `const result = await tools.toolOrchestrator({
    parameters: { "minFileSizeMB": 10 },
    preProcessingScript: \`
        // Setup: Find ALL components
        context.log('Finding ALL components in Publication...');
        const allItems = await context.tools.getItemsInContainer({
            containerId: "tcm:0-5-1", itemTypes: ["Component"], recursive: true, details: "IdAndTitle"
        });
        return allItems.map(item => item.Id);
    \`,
    mapScript: \`
        const minBytes = context.parameters.minFileSizeMB * 1024 * 1024;

        // 1. Fetch properties to identify type and size
        const item = await context.tools.getItem({ 
            itemId: context.currentItemId,
            includeProperties: ["Title", "ComponentType", "BinaryContent.Size"]
        });

        // 2. Filter: Must be Multimedia and Large
        if (!item || item.ComponentType !== 'Multimedia' || !item.BinaryContent) return null;
        if (item.BinaryContent.Size < minBytes) return null;

        context.log(\`Found large file: \${item.Title} (\${item.BinaryContent.Size} bytes)\`);

        // 3. Usage Check: Get dependency graph
        const graph = await context.tools.getDependencyGraph({
            itemId: context.currentItemId,
            direction: "UsedBy",
            rloItemTypes: ["Page"], // Only care about Page usages
            details: "IdAndTitle"
        });

        // Helper to recursively flatten graph
        function flattenPageIds(node) {
            let ids = [];
            if (!node) return ids;
            // If this node is a Page, add it
            if (node.Item && node.Item.ItemType === 'Page') ids.push(node.Item.Id);
            
            if (node.Dependencies) {
                for (const child of node.Dependencies) {
                     ids = ids.concat(flattenPageIds(child));
                }
            }
            return [...new Set(ids)];
        }
        
        const pageIds = flattenPageIds({ Dependencies: graph });
        if (pageIds.length === 0) {
             return { id: item.Id, title: item.Title, size: item.BinaryContent.Size, reason: "Unused by any Page" };
        }

        // 4. Check if any using Pages are published
        for (const pageId of pageIds) {
            const publishInfo = await context.tools.getPublishInfo({ 
                itemId: pageId, includeProperties: ["PublishedAt"] 
            });
            if (publishInfo && publishInfo.length > 0) return null;
        }
        
        return { id: item.Id, title: item.Title, size: item.BinaryContent.Size, reason: "Used only by unpublished Pages" };
    \`,
    postProcessingScript: \`
        // Reduce: Collect list of candidates for deletion
        const candidates = context.successes.map(s => s.result).filter(r => r !== null);
        return { 
            totalFilesToReview: candidates.length, 
            filesToReview: candidates 
        };
    \`
});`
        },
        {
            description: "\"Fail Loudly\" Pattern (Handling Missing Dependencies): Ensures that if a dependency is missing, the script throws an Error instead of silently continuing.",
            payload: `const result = await tools.toolOrchestrator({
    mapScript: \`
        const mapping = context.preProcessingResult.mapping;
        const targetId = mapping[context.currentItemId];
        
        // FAIL LOUDLY: Do not just return null or console.log.
        // Throwing an error ensures this item is counted as "failed" in the summary.
        if (!targetId) {
            throw new Error(\`Critical: No mapping found for item \${context.currentItemId}\`);
        }
        
        await context.tools.addLink({ parentId: context.currentItemId, childId: targetId });
        return { status: "Linked" };
    \`
});`
        },
        {
            description: "Discovery-Only (The \"Turn 1\" Pattern): Finds items and returns them immediately without mapping or validating. Perfect for generating lists for user confirmation before a destructive action.",
            payload: `const result = await tools.toolOrchestrator({
    preProcessingScript: \`
        context.log('Phase 1: Finding items to delete...');
        const items = await context.tools.getItemsInContainer({
            containerId: "tcm:5-1505-2", itemTypes: ["Folder"]
        });
        // Return the array of IDs for Turn 2.
        // For 'preProcessingResult', map the items to return ONLY the Id and Title 
        // to save tokens, as that is all you need for the user confirmation message.
        return {
            itemIds: items.map(i => i.Id),
            preProcessingResult: items.map(i => ({ Id: i.Id, Title: i.Title }))
        };
    \`
});`
        }
    ],

    input: toolOrchestratorInputProperties,

    execute: async (
        input: z.infer<typeof toolOrchestratorSchema>,
        mcpContext: any
    ) => {
        formatForApi(input);
        const {
            itemIds: initialItemIds,
            preProcessingScript,
            mapScript,
            postProcessingScript,
            parameters = {},
            stopOnError,
            maxConcurrency,
            includeScriptResults,
            debug
        } = input;

        // --- PRE-FLIGHT VALIDATION: Tool Initialization Check ---
        const requiredTools = scanForRequiredTools([preProcessingScript, mapScript, postProcessingScript]);
        const unlockedTools = mcpContext.unlockedTools as Set<string> | undefined;
        const missingInitializations: string[] = [];
        const forbiddenTools: string[] = [];

        for (const toolName of requiredTools) {
            if (DISALLOWED_TOOLS.includes(toolName)) {
                forbiddenTools.push(toolName);
                continue;
            }
            if (unlockedTools && !unlockedTools.has(toolName)) {
                missingInitializations.push(toolName);
            }
        }

        if (forbiddenTools.length > 0) {
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        type: "ValidationError",
                        Message: `Operation Aborted: The script uses forbidden tools ([${forbiddenTools.join(', ')}]).`
                    })
                }]
            };
        }

        if (missingInitializations.length > 0) {
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        type: "ValidationError",
                        Message: `Operation Aborted: The script uses tools that have not been initialized ([${missingInitializations.join(', ')}]). You must call '_initializeTools' first.`
                    })
                }]
            };
        }
        // ---------------------------------------------------------

        /** Helper to extract a clear error message. */
        const extractErrorMessage = (e: any): string => {
            try {
                if (!e) return 'Unknown error';
                if (e.message) return e.message;
                if (typeof e === 'string') return e;
                if (e.content && Array.isArray(e.content) && e.content[0]?.type === 'text') {
                    try {
                        const errorObj = JSON.parse(e.content[0].text);
                        const formattedError = formatForAgent(errorObj);
                        if (formattedError && formattedError.Message) {
                            return JSON.stringify(formattedError);
                        }
                    } catch {
                        return e.content[0].text;
                    }
                    return e.content[0].text;
                }
                return JSON.stringify(e);
            } catch {
                return String(e);
            }
        }

        if (!mcpContext.tools || typeof mcpContext.tools !== 'object') {
            return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: "Tool execution context is missing. 'toolOrchestrator' cannot access other tools." }) }] };
        }

        const results: any[] = [];
        const logs: string[] = [];
        const log = (message: string) => logs.push(message);

        // --- Create Tool Wrappers ---
        const toolWrappers: { [toolName: string]: (args: any) => Promise<any> } = {};

        for (const toolName in mcpContext.tools) {
            // Check if the tool is unlocked for this session (Initialization Interlock)
            if (unlockedTools && !unlockedTools.has(toolName)) {
                toolWrappers[toolName] = async (_args: any) => {
                    throw new Error(`SecurityError: Tool [${toolName}] is not initialized. You must call '_initializeTools' natively before using it in a script.`);
                };
                continue;
            }

            if (DISALLOWED_TOOLS.includes(toolName)) {
                toolWrappers[toolName] = async (_args: any) => {
                    throw new Error(`ToolError: The tool "${toolName}" is not permitted to be called from within the toolOrchestrator for security reasons.`);
                };
                continue;
            }

            if (mcpContext.tools[toolName] && mcpContext.tools[toolName].execute) {
                const originalTool = mcpContext.tools[toolName];
                const originalToolExecute = originalTool.execute;
                const toolInputProperties = originalTool.input;

                const standardWrapper = async (args: any) => {
                    let validatedArgs = args || {};
                    validatedArgs = formatForAgent(validatedArgs);
                    if (toolInputProperties && typeof toolInputProperties === 'object') {
                        const toolInputSchema = z.object(toolInputProperties);
                        const validationResult = toolInputSchema.safeParse(validatedArgs);
                        if (!validationResult.success) {
                            throw new Error(`Invalid arguments for tool '${toolName}': ${validationResult.error.message}`);
                        }
                        validatedArgs = validationResult.data;
                    }

                    const result = await originalToolExecute(validatedArgs, mcpContext);

                    if (result && result.content && Array.isArray(result.content) &&
                        result.content[0] && result.content[0].type === 'text' &&
                        typeof result.content[0].text === 'string') {
                        const maybeText = result.content[0].text.trim();
                        if (maybeText.startsWith('{') || maybeText.startsWith('[')) {
                            try {
                                const parsedObject = JSON.parse(maybeText);
                                if (parsedObject && parsedObject.type === 'Error' && parsedObject.Message) {
                                    throw new Error(parsedObject.Message);
                                }
                                return applyItemIdAlias(parsedObject);
                            } catch (err) {
                                throw err;
                            }
                        }
                    }
                    if (result && typeof result === 'object' && !Array.isArray(result) && !result.content) {
                        return applyItemIdAlias(result);
                    }
                    return applyItemIdAlias(result);
                };

                // Idempotency Wrapper
                if (["createItem", "createPage", "createComponent", "createComponentSchema",
                    "createRegionSchema", "createMetadataSchema", "createPublication"].includes(toolName)) {
                    toolWrappers[toolName] = async (args: any) => {
                        try {
                            return await standardWrapper(args);
                        } catch (error: any) {
                            const errorMessage = (error?.message || error?.toString() || "").toLowerCase();
                            const errorContent = (error?.content) ? JSON.stringify(error.content).toLowerCase() : "";
                            const isConflict = (error?.status === 409) ||
                                errorMessage.includes("already exists") ||
                                errorMessage.includes("itemalreadyexists") ||
                                errorMessage.includes("status 409") ||
                                errorContent.includes("already exists") ||
                                errorContent.includes("itemalreadyexists");

                            if (!isConflict) throw error;
                            if (input.forceSkipIfPresent) {
                                return {
                                    type: "Skipped",
                                    Id: "Existing-Unknown",
                                    Message: "Item already exists. Skipped by request (forceSkipIfPresent=true).",
                                    Status: "Success (Skipped)"
                                };
                            }
                            throw new Error(`Idempotency Error: Item already exists. To skip existing items, set 'forceSkipIfPresent: true' in the tool parameters.`);
                        }
                    }
                } else {
                    toolWrappers[toolName] = standardWrapper;
                }
            }
        }

        const baseSandbox = createBaseSandbox();
        let finalItemIds: string[] = initialItemIds || [];
        let preScriptContextData: any = {};

        // --- Phase 1: Pre-Processing Logic (Setup Phase) ---
        if (preProcessingScript) {
            logs.push("Starting pre-processing script (setup phase)...");
            let compiledPreScript: vm.Script;
            try {
                compiledPreScript = new vm.Script(`(async () => { "use strict"; ${preProcessingScript} })();`, { filename: 'preProcessingScript.js' });
            } catch (error: any) {
                return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: `Pre-processing Script Compilation Error: ${extractErrorMessage(error)}` }) }] };
            }

            const preScriptLog = (message: string) => logs.push(`[PreScript] ${message}`);
            const preScriptContext: PreScriptContext = {
                parameters: Object.freeze(parameters),
                tools: toolWrappers,
                utils: scriptUtils,
                log: preScriptLog
            };
            const sandboxContext = { ...baseSandbox, context: preScriptContext, console: { log: preScriptLog } };
            const sandbox = vm.createContext(sandboxContext);
            try {
                const scriptPromise = compiledPreScript.runInContext(sandbox, { timeout: SYNC_SCRIPT_TIMEOUT_MS });
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`Script timed out after ${TOTAL_SCRIPT_TIMEOUT_MS}ms`)), TOTAL_SCRIPT_TIMEOUT_MS));
                const preScriptResult = await Promise.race([scriptPromise, timeoutPromise]);

                if (Array.isArray(preScriptResult) && preScriptResult.every(item => typeof item === 'string')) {
                    finalItemIds = preScriptResult;
                } else if (typeof preScriptResult === 'object' && preScriptResult !== null && Array.isArray(preScriptResult.itemIds)) {
                    finalItemIds = preScriptResult.itemIds;
                    if (preScriptResult.preProcessingResult) preScriptContextData = Object.freeze(preScriptResult.preProcessingResult);
                }
                logs.push(`Pre-processing script finished. Found ${finalItemIds.length} items.`);
            } catch (error: any) {
                const errorMessage = extractErrorMessage(error);
                return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: `Pre-processing phase failed: ${errorMessage}` }) }] };
            }
        }

        if (finalItemIds.length === 0) {
            logs.push("No items provided or found during pre-processing. Skipping Map and Reduce phases.");

            const emptyResult: OrchestratorResult = {
                status: "Completed",
                summary: "Operation completed: 0 items found to process.",
                processedItems: [],
                output: preScriptContextData // Pass along any setup data just in case
            };

            if (debug) {
                emptyResult.executionLog = logs.join('\n');
            }

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(emptyResult, null, 2)
                }],
            };
        }

        // --- Phase 2: Execution Logic (Map Phase) ---
        let wasStoppedOnError = false;

        if (!mapScript) {
            // GRACEFUL EXIT: If there's no mapScript, this was purely a discovery/setup call (e.g., Turn 1 of deletion).
            logs.push("No mapScript provided. Ending execution after pre-processing and returning discovered items.");

            const discoveryResult: OrchestratorResult = {
                status: "Completed",
                summary: `Discovery completed: ${finalItemIds.length} items found.`,
                processedItems: finalItemIds.map(id => ({ id, result: "Discovered" })),
                output: preScriptContextData
            };

            if (debug) {
                (discoveryResult as any).executionLog = logs.join('\n');
            }

            return {
                content: [{ type: "text", text: JSON.stringify(discoveryResult, null, 2) }],
            };
        }

        log(`\nStarting map phase for ${finalItemIds.length} items...`);
        let compiledMapScript: vm.Script;
        try {
            compiledMapScript = new vm.Script(`(async () => { "use strict"; ${mapScript} })();`, { filename: 'mapScript.js' });
        } catch (error: any) {
            return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: `Map Script Compilation Error: ${extractErrorMessage(error)}` }) }] };
        }

        const runTask = async (itemId: string, index: number): Promise<void> => {
            logs.push(`\n[${index + 1}/${finalItemIds.length}] Processing item: ${itemId}`);
            let itemHasWarning = false;
            let itemWarningMessage = "";

            const perItemLog = (message: string) => logs.push(`[${itemId}] ${message}`);
            const perItemWarnLog = (message: string) => { logs.push(`[${itemId}] [WARN] ${message}`); itemHasWarning = true; itemWarningMessage = message; };

            const perItemContext: MapScriptContext = {
                currentItemId: itemId,
                parameters: Object.freeze(parameters),
                preProcessingResult: preScriptContextData,
                tools: toolWrappers,
                utils: scriptUtils,
                log: perItemLog
            };
            const sandboxContext = { ...baseSandbox, context: perItemContext, console: { log: perItemLog, warn: perItemWarnLog, error: perItemLog } };
            const sandbox = vm.createContext(sandboxContext);

            try {
                const scriptPromise = compiledMapScript.runInContext(sandbox, { timeout: SYNC_SCRIPT_TIMEOUT_MS });
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`Script timed out after ${TOTAL_SCRIPT_TIMEOUT_MS}ms`)), TOTAL_SCRIPT_TIMEOUT_MS));
                const result = await Promise.race([scriptPromise, timeoutPromise]);

                const safeResult = result === undefined ? "No return value" : result;

                if (itemHasWarning) {
                    results.push({ itemId, status: "warning", result: safeResult, warning: itemWarningMessage });
                } else {
                    results.push({ itemId, status: "success", result: safeResult });
                }
            } catch (error: any) {
                const errorMessage = extractErrorMessage(error);
                logs.push(`[${itemId}] FAILED: ${errorMessage}`);

                // Always record the failure
                results.push({ itemId: itemId, status: "error", error: errorMessage });

                if (stopOnError) {
                    // Mark global stop flag. The loop controller will handle the break.
                    wasStoppedOnError = true;
                }
            }
        };

        // Execution Loop
        if (maxConcurrency === 1) {
            for (const [index, itemId] of finalItemIds.entries()) {
                if (wasStoppedOnError) break; // STOP Condition
                await runTask(itemId, index);
            }
        } else {
            const workerPool = new Set<Promise<void>>();
            let index = 0;
            for (const itemId of finalItemIds) {
                if (wasStoppedOnError) break; // STOP Condition (prevents NEW tasks)

                while (workerPool.size >= maxConcurrency) {
                    await Promise.race(workerPool);
                }
                // Double check in case a worker failed while we were waiting
                if (wasStoppedOnError) break;

                const taskPromise = runTask(itemId, index++);
                const onFinally = () => workerPool.delete(taskPromise);
                taskPromise.then(onFinally, onFinally);
                workerPool.add(taskPromise);
            }
            await Promise.allSettled(Array.from(workerPool));
        }
        logs.push("\nMap phase finished.");

        // --- Categorize Results ---
        const successes = results.filter(r => r.status === 'success');
        const warnings = results.filter(r => r.status === 'warning');
        const failures = results.filter(r => r.status === 'error');

        // --- STOPPED ON ERROR EXIT ---
        if (wasStoppedOnError && failures.length > 0) {
            // We use the first failure as the "primary" reason for the stop,
            // but we acknowledge that concurrent threads may have produced other errors.
            const primaryFailure = failures[0];
            const otherFailures = failures.slice(1);

            let summaryText = `Execution stopped due to error on item '${primaryFailure.itemId}'.`;

            if (otherFailures.length > 0) {
                summaryText += ` ${otherFailures.length} other item(s) also failed concurrently (IDs: ${otherFailures.map(f => f.itemId).join(", ")}).`;
            }

            summaryText += ` Processed ${successes.length} items successfully before stop.`;

            const stoppedResult: OrchestratorResult = {
                status: "StoppedOnError",
                summary: summaryText,
                processedItems: successes.map(s => ({ id: s.itemId, result: s.result })),
                // We strictly map the structure to match the interface expected
                failedItem: { id: primaryFailure.itemId, error: primaryFailure.error }
            };

            // If debug is on, we can include the full details of all failures in the log
            if (debug) {
                (stoppedResult as any).executionLog = logs.join('\n');
                (stoppedResult as any).allFailures = failures;
            }

            return {
                content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: summaryText, Details: stoppedResult }, null, 2) }]
            };
        }

        // --- Phase 3: Post-Processing Logic (Reduce Phase) ---
        // Runs only if we completed the loop (even with failures, if stopOnError=false)
        let responsePayload: any = null;

        if (postProcessingScript) {
            logs.push("\nStarting post-processing script (reduce phase)...");
            let compiledPostScript: vm.Script;
            try {
                compiledPostScript = new vm.Script(`(async () => { "use strict"; ${postProcessingScript} })();`, { filename: 'postProcessingScript.js' });
            } catch (error: any) {
                return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: `Post-processing Script Compilation Error: ${extractErrorMessage(error)}` }) }] };
            }

            const postScriptLog = (message: string) => logs.push(`[PostScript] ${message}`);
            const sandboxContext = {
                ...baseSandbox,
                context: {
                    results: Object.freeze(results),
                    successes: Object.freeze(applyItemIdAlias(successes)),
                    warnings: Object.freeze(warnings),
                    failures: Object.freeze(failures),
                    parameters: Object.freeze(parameters),
                    preProcessingResult: preScriptContextData,
                    tools: toolWrappers,
                    utils: scriptUtils,
                    log: postScriptLog
                },
                console: { log: postScriptLog }
            };
            const sandbox = vm.createContext(sandboxContext);
            try {
                const scriptPromise = compiledPostScript.runInContext(sandbox, { timeout: SYNC_SCRIPT_TIMEOUT_MS });
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`Script timed out after ${TOTAL_SCRIPT_TIMEOUT_MS}ms`)), TOTAL_SCRIPT_TIMEOUT_MS));
                responsePayload = await Promise.race([scriptPromise, timeoutPromise]);
                logs.push("Post-processing script finished successfully.");
            } catch (error: any) {
                const postError: OrchestratorResult = {
                    status: "StoppedOnError",
                    summary: "Map phase completed, but Post-Processing script failed.",
                    processedItems: successes.map(s => ({ id: s.itemId, result: s.result })),
                    failedItem: { id: "PostProcessingScript", error: extractErrorMessage(error) }
                };
                return { content: [{ type: "text", text: JSON.stringify({ type: "Error", Message: postError.summary, Details: postError }) }] };
            }
        } else {
            // Default Summary if no post-script
            responsePayload = {
                summary: "ToolOrchestrator Operation Completed",
                totalItemsProcessed: finalItemIds.length,
                succeeded: successes.length,
                warnings: warnings.length,
                failed: failures.length,
                results: includeScriptResults ? successes.map(r => ({ itemId: r.itemId, result: r.result })) : undefined
            };
        }

        // --- Final Output Construction (Structured) ---
        const finalStatus = failures.length > 0 ? "PartialSuccess" : "Completed";

        const truncatedSuccesses = successes.slice(0, 3).map(s => ({ id: s.itemId, result: s.result }));
        const truncatedFailures = failures.slice(0, 3).map(f => ({ id: f.itemId, error: f.error }));

        // 2. Clean up the output payload to prevent echoing massive datasets
        let safeOutput = responsePayload;

        if (typeof responsePayload === 'object' && responsePayload !== null) {
            // Check if the payload is DIRECTLY an array
            if (Array.isArray(responsePayload)) {
                if (responsePayload.length > 10) {
                    safeOutput = [
                        ...responsePayload.slice(0, 10),
                        `... (${responsePayload.length - 10} more items truncated to save tokens)`
                    ];
                } else {
                    safeOutput = [...responsePayload];
                }
            } else {
                // Otherwise, it's an object. Check its properties.
                safeOutput = { ...responsePayload };
                delete safeOutput.preProcessingResult;
                delete safeOutput.sourceData;

                for (const key of Object.keys(safeOutput)) {
                    if (Array.isArray(safeOutput[key]) && safeOutput[key].length > 10) {
                        safeOutput[key] = [
                            ...safeOutput[key].slice(0, 10),
                            `... (${safeOutput[key].length - 10} more items truncated to save tokens)`
                        ];
                    }
                }

                // If the default summary included the full results array, truncate it
                if (Array.isArray(safeOutput.results) && safeOutput.results.length > 3) {
                    safeOutput.results = [
                        ...safeOutput.results.slice(0, 3),
                        `... (${safeOutput.results.length - 3} more items truncated)`
                    ];
                    safeOutput.resultsTruncated = true;
                }
            }
        }

        const finalOutput: OrchestratorResult = {
            status: finalStatus,
            summary: (typeof responsePayload === 'string') ? responsePayload : (responsePayload?.summary || `Operation ${finalStatus}. Processed: ${finalItemIds.length}, Succeeded: ${successes.length}, Failed: ${failures.length}`),
            processedItems: truncatedSuccesses,
            failedItem: truncatedFailures.length > 0 ? truncatedFailures[0] : undefined,
            output: safeOutput
        };

        if (debug) {
            let logOutput = logs;
            if (logs.length > 50) {
                logOutput = [...logs.slice(0, 25), `... (log truncated - ${logs.length - 50} lines hidden) ...`, ...logs.slice(-25)];
            }
            (finalOutput as any).executionLog = logOutput.join('\n');
        }

        return {
            content: [{
                type: "text",
                text: JSON.stringify(finalOutput, null, 2)
            }],
        };
    }
};