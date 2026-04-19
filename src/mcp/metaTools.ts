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
    const unlockedTools = new Set<string>(['_initializeTools', '_syncTools']);
    const registeredOnServer = new Set<string>(['_initializeTools', '_syncTools']);

    /**
     * The _syncTools tool acts as a synchronization barrier (a "yield").
     * Its primary purpose is to force a network round-trip so that the client 
     * (like Gemini CLI) has a wall-clock 'tick' to process the notifications 
     * queue and hydrate the registry before the next substantive tool call.
     */
    const _syncTools = {
        name: "_syncTools",
        summary: "Yields execution to the client for state synchronization.",
        examples: [],
        description: "This is a synchronization tool. When called, it returns a success message. Its primary purpose is to create a network round-trip ('tick') that allows the client (e.g., Gemini CLI) to process background notifications, such as tool list updates from JIT hydration, before the next real step is taken.",
        input: {},
        execute: async () => {
            return {
                content: [{
                    type: "text",
                    text: "Sync tick completed. You may now proceed with using the newly hydrated tools."
                }]
            };
        }
    };

    /**
     * The _initializeTools meta-tool replaces getToolDetails.
     * It allows the AI assistant to browse lightweight summaries and "fetch"
     * full documentation, while simultaneously registering the tools as native MCP tools.
     */
    const _initializeTools = {
        name: "_initializeTools",
        summary: "Initializes CMS tools for active use.",
        examples: [],
        get description() {
            const summaryString = getToolsSummary();
            return `
## USAGE PROTOCOL
1.  Select tools from the 'AVAILABLE TOOLS' menu below.
2.  Call this tool to hydrate them into your native registry.
3.  **Mandatory Synchronization**: Immediately after calling this tool, you **MUST** call the \`_syncTools\` tool as your very next action. This ensures the client (e.g. Gemini CLI) has time to process the tool refresh before you attempt to use those tools natively or in a subagent.

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
            toolNames: z.array(z.string()).describe("An array of exact tool names to retrieve documentation for and register for use.")
        },
        execute: async ({ toolNames }: { toolNames: string[] }) => {
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

                        server.registerTool(
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
                    // Send tool list changed notification
                    // @ts-ignore - access underlying server notification system
                    const rawServer = (server as any).server;
                    if (rawServer && typeof rawServer.notification === 'function') {
                        rawServer.notification({ method: "notifications/tools/list_changed" });
                    }
                } catch (e) {
                    console.error("[Discovery] Failed to send list_changed notification:", e);
                }
            }

            let message = "";
            if (successNames.length > 0) {
                message += `Successfully initialized: ${successNames.join(', ')}. `;
            }
            if (failureNames.length > 0) {
                message += `Failed to initialize: ${failureNames.join(', ')}.`;
            }

            return {
                content: [{
                    type: "text",
                    text: message || "No tools were processed."
                }]
            };
        }
    };

    return { _initializeTools, _syncTools, unlockedTools };
}
