import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getToolRegistry, getToolsSummary, Tool } from "../utils/toolRegistry.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Initializes session-specific meta-tools and state for a given McpServer instance.
 * Using a factory ensures that 'unlockedTools' and dynamic registrations are 
 * isolated per session/connection.
 */
export function initializeSessionTools(server: McpServer) {
    // State isolated to this session's closure
    const unlockedTools = new Set<string>(['_initializeTools']);
    const registeredOnServer = new Set<string>(['_initializeTools']);
    const activeRegistrations = new Map<string, any>();



    /**
     * The _initializeTools meta-tool is used to hydrate and register 
     * required tools into the host registry. The AI selects tools from 
     * the 'AVAILABLE TOOLS' summary to initialize them for use.
     */
    const _initializeTools = {
        name: "_initializeTools",
        summary: "Initializes CMS tools for active use.",
        examples: [],
        get description() {
            const summaryString = getToolsSummary();
            return `
## USAGE PROTOCOL
1.  Select tools from the 'AVAILABLE TOOLS' menu below. Only initialize the set of tools required for your immediate needs (i.e., tool execution or documentation lookup). Hydrating tools that are not required can increase latency and token costs.
2.  Call this tool to hydrate them into your native registry.
3.  **Mandatory Yield**: After calling this tool, you **MUST** state your execution plan and then STOP your response to yield the turn. This allows the client (e.g. Gemini CLI) to process the tool refresh before you attempt to use those tools in the next turn.

Note: This tool performs an **exclusive refresh** of the registry. Any tools initialized in a previous turn that are not included in the current 'toolNames' list will be removed from your active toolset.

Note: Tools must be initialized here before they can be used natively or within the \`toolOrchestrator\`.

## CRITICAL CMS ARCHITECTURE & OPERATIONAL HEURISTICS

You are an expert collaborator for the Tridion Sites Content Management System. Before answering any “how-to” question, you **MUST** first review the **AVAILABLE TOOLS** and their documentation to provide a technically grounded answer.

### 1. BluePrint Architecture
* **Top-Down Inheritance:** Items in a parent publication are inherited by child publications. Inherited items are read-only (IsShared = true, IsLocalized = false) by default. To edit an inherited item, it first needs to be localized (via \`localizeItem\`).
* **404 Remediation:** A 404 error usually means a dependency (Schema/Keyword) exists in a sibling or child publication. Remediate by using \`promoteItem\` to move it to a common ancestor, or find an equivalent item in the current context.
* **BluePrinting Conventions:** Create new items in a suitable publication: **Schema Master** (Schemas/Categories), **Design Master** (Templates), **Content Master** (Components), **Website Master** (Pages/Structure/Groups), **Regional Websites** (Localized content).

### 2. Architecture & Identity
* **Container Affinity:** Repository objects are not interchangeable:
    * **Folders (-2):** Contain Components, Schemas, Templates, Bundles, sub-Folders etc.
    * **Structure Groups (-4):** Contain Pages and sub-Structure Groups.
* **Identity Formats:** Use **TCM URIs** (\`tcm:Pub-Item-Type\`) for native items and **ECL IDs** (\`ecl:provider-id\`) for external media.
* **Component Presentation Identity:** A Component Presentation consists of a **Component** (content) and an **optional Component Template** (rendering instructions). While traditional sites require a Template for HTML generation, modern "Headless" sites may omit it. You **MUST** use the \`getIsComponentTemplateRequired\` tool to verify the requirements for the current environment. A Page may contain multiple instances of the same Component using different Templates (e.g., a 'Teaser' vs. a 'Full' view).
* **Page Content Structure:** Tridion content is distributed across two separate properties on a Page: the root-level \`ComponentPresentations\` AND nested within \`Regions\`. Modern sites prioritize Regions for layout. When auditing, searching, or updating content, you **MUST** inspect both locations.
* **The Find-Then-Fetch Pattern:** Discovery tools return shallow URIs. When fetching details via \`getItem\` or \`bulkReadItems\`, you **MUST** use the \`includeProperties\` parameter to prevent token bloat.

### 3. Schema & Lifecycle Rules
* **Component Metadata:** Metadata **MUST** be defined within the Component Schema itself via the \`metadataFields\` array. Components cannot link to standalone Metadata Schemas.
* **Automatic Locking:** Standard update tools handle check-out/check-in automatically. If an update fails due to a lock, run \`getItem\` to inspect \`LockInfo\`, report the user holding the lock, and **STOP**.

### 4. Batch Operations & Orchestration
* **Delegation:** Never pull > 5 items into the chat context. Use a \`mapScript\` via \`toolOrchestrator\` to process batches server-side.
* **Spreadsheet Triage:** Read initial sheets with \`maxRows: 3\` and process the full sheet via \`toolOrchestrator\`. **Exception:** If a sheet contains non-tabular text (e.g., "Instructions" or "Notes"), you **MUST** read all rows for that specific sheet.
* **Mandatory Dry Run:** When using the \`toolOrchestrator\` always process 1–2 items first to verify logic before running bulk loops.
* **Fail Loudly:** Do not wrap mutation calls in silent \`try/catch\` blocks. Let errors throw naturally so \`stopOnError: true\` can halt the process.
* **Defensive Validation:** Use \`context.utils.assert()\` within scripts to verify state changes post-mutation (Read-After-Write) to catch logical errors before they propagate.

### 5. Guardrails
* **Explicit Consent:** NEVER execute destructive actions (\`deleteItem\`, \`unlocalizeItem\`, \`undoCheckOutItem\`) without explicit confirmation. **Exception:** You may delete items you mistakenly created in the current turn.
* **Short-Circuiting:** * If a request is vague (e.g., "update the article"), do **NOT** guess; ask for specific IDs.
    * If a request is out-of-domain (e.g., "Mango the orange..."), do **NOT** call CMS tools. Respond politely and pivot back to the CMS.
* **Native Over Custom:** Always prioritize solving requirements through native parameters and schema-level properties (e.g., field flags, mandatory settings) as the primary solution before proposing custom extensions, C# scripts, or event handlers.
* **Scripting API Integrity:** When using \`toolOrchestrator\`, the \`context.tools\` object exposes ONLY the tools listed in this documentation. You **MUST** call \`_initializeTools\` natively for any tool you intend to use in a script to verify its exact name and parameter schema.

The list of "AVAILABLE TOOLS" below contains concise "SEO hooks" (summaries) for each tool. Use these hooks to identify which tool possesses the knowledge needed to answer a user's question.

AVAILABLE TOOLS:
${summaryString}

If a tool's description mentions using another tool, you must initialize that referenced tool before use.`;
        },
        input: {
            toolNames: z.array(z.string()).describe("An array of exact tool names to retrieve documentation for and register for use."),
            resumeTask: z.string().optional().describe("A brief summary of the original user request. This will be echoed back in the response to ensure continuity after the registry refresh.")
        },
        execute: async ({ toolNames, resumeTask }: { toolNames: string[], resumeTask?: string }) => {
            // --- Reset Logic: Exclusive Refresh ---
            // Remove any previously hydrated tools to keep the registry lean and predictable.
            for (const [name, registeredTool] of activeRegistrations.entries()) {
                try {
                    console.error(`[Discovery] Purging tool '${name}' to prepare for exclusive refresh.`);
                    registeredTool.remove();
                } catch (e) {
                    console.error(`[Discovery] Warning: Failed to remove tool '${name}':`, e);
                }
            }
            activeRegistrations.clear();
            unlockedTools.clear();
            registeredOnServer.clear();

            // Re-unlock _initializeTools
            unlockedTools.add('_initializeTools');
            registeredOnServer.add('_initializeTools');

            const registry = getToolRegistry();
            let toolsRegisteredCount = 0;
            const successNames: string[] = [];
            const failureNames: string[] = [];

            toolNames.forEach(name => {
                const tool = registry.get(name);
                if (!tool) {
                    failureNames.push(name);
                    return;
                }

                // --- Dynamic Tool Registration (JIT) ---
                if (!registeredOnServer.has(tool.name)) {
                    try {
                        console.error(`[Discovery] JIT Hydration: Registering tool '${tool.name}'`);

                        // Append examples to description as requested
                        let fullDescription = `${tool.summary}\n\n${tool.description}`;
                        if (tool.examples && tool.examples.length > 0) {
                            fullDescription += `\n\n### Examples\n${JSON.stringify(tool.examples, null, 2)}`;
                        }

                        const registeredTool = server.registerTool(
                            tool.name,
                            {
                                description: fullDescription,
                                inputSchema: tool.input,
                            },
                            (args: any, context: any) => {
                                return tool.execute(args, { ...context, unlockedTools });
                            }
                        );

                        registeredOnServer.add(tool.name);
                        activeRegistrations.set(tool.name, registeredTool);
                        toolsRegisteredCount++;
                    } catch (error) {
                        console.error(`[Discovery] Failed to register tool ${tool.name}:`, error);
                        failureNames.push(name);
                        return;
                    }
                }

                // Track as unlocked for orchestrator even if already registered on server
                unlockedTools.add(tool.name);
                successNames.push(tool.name);
            });

            // Notify client if new tools were registered
            if (toolsRegisteredCount > 0) {
                console.error(`[Discovery] Notifying client: tools list changed (${toolsRegisteredCount} new tools)`);
                try {
                    // Send tool list changed notification using the official SDK method
                    server.sendToolListChanged();
                } catch (e) {
                    console.error("[Discovery] Failed to send list_changed notification:", e);
                }
            }

            const receipt = `SUCCESS: The following tools were verified and registered natively: [${successNames.join(', ')}].

VERIFIED STATE: Your native registry is now refreshed. You have full access to the Zod schemas and BluePrint heuristics for these tools.

RESUME TASK: ${resumeTask || "Proceed with the requested operation."}

MANDATORY NEXT STEP:
1. State your execution plan using the new tools.
2. STOP your response immediately (Yield Turn).
3. Execute the tools in the next turn once the Host registry has synced.`;

            return {
                content: [{
                    type: "text",
                    text: receipt
                }]
            };
        }
    };

    return { _initializeTools, unlockedTools };
}
