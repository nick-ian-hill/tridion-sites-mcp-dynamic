import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import crypto from 'node:crypto';

export interface Tool {
    name: string;
    summary: string;
    description: string;
    examples: any[];
    input: any;
    execute: (args: any, context: any) => Promise<any>;
    guid?: string;
}

export function isTool(obj: any): obj is Tool {
    return (
        obj &&
        typeof obj === 'object' &&
        'name' in obj && typeof obj.name === 'string' &&
        'summary' in obj && typeof obj.summary === 'string' &&
        'description' in obj && typeof obj.description === 'string' &&
        'examples' in obj && Array.isArray(obj.examples) &&
        'input' in obj &&
        'execute' in obj && typeof obj.execute === 'function'
    );
}

/**
 * Generates a stable GUID for a tool name.
 */
function generateToolGuid(name: string): string {
    const hash = crypto.createHash('sha256').update(`tridion-mcp-salt-${name}`).digest('hex');
    // Format as 8-4-4-4-12 (GUID/UUID format)
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`.toUpperCase();
}

let toolRegistry: Map<string, Tool> = new Map();

/**
 * Initializes the tool registry by dynamically loading tools from the tools/ directory
 * and combining them with manually provided tools.
 */
export async function initializeToolRegistry(manualTools: Tool[] = []): Promise<Map<string, Tool>> {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const toolsDirPath = path.resolve(__dirname, '..', 'tools');

    const loadedToolsMap = new Map<string, Tool>();

    // 1. Manually add tools (like UI assistant tools)
    for (const tool of manualTools) {
        if (isTool(tool)) {
            tool.guid = generateToolGuid(tool.name);
            loadedToolsMap.set(tool.name, tool);
        }
    }

    // 2. Dynamically load standard tools from the tools/ directory
    try {
        const toolFiles = await fs.readdir(toolsDirPath);
        for (const file of toolFiles) {
            if (file.endsWith('.ts') || file.endsWith('.js')) {
                // Skip files that aren't tool definitions if any exist (though currently they all seem to be tools)
                const modulePath = path.join(toolsDirPath, file);
                const moduleUrl = pathToFileURL(modulePath).href;
                const module = await import(moduleUrl);

                // Most tools export the tool object as the only value or as a named export
                // We'll look for the first valid tool object in the module exports
                const potentialTool = Object.values(module).find(isTool);

                if (potentialTool) {
                    if (!loadedToolsMap.has(potentialTool.name)) {
                        potentialTool.guid = generateToolGuid(potentialTool.name);
                        loadedToolsMap.set(potentialTool.name, potentialTool);
                    }
                } else {
                    console.warn(`Warning: File ${file} does not export a valid tool object.`);
                }
            }
        }
    } catch (error) {
        console.error("Error loading tools for registry:", error);
    }

    toolRegistry = loadedToolsMap;
    console.error(`Successfully loaded ${toolRegistry.size} tools into the registry. These will be exposed via the dynamic meta-tool _setTools.`);
    return toolRegistry;
}

/**
 * Returns the central tool registry.
 */
export function getToolRegistry(): Map<string, Tool> {
    return toolRegistry;
}


/**
 * Generates a bulleted list of all available tools, optionally including their parameter lists.
 */
export function getToolsSummary(): string {
    const categories: Record<string, string[]> = {
        "Search & Discovery": ['search', 'getItemsInContainer', 'getItem', 'bulkReadItems', 'getLockedItems'],
        "Item Management (CRUD)": ['createItem', 'createComponent', 'createPage', 'updateContent', 'updateMetadata', 'updatePage', 'updateItemProperties', 'deleteItem', 'copyItem', 'moveItem'],
        "Taxonomy & Classification": ['getCategories', 'getClassificationKeywordsForCategory', 'getItemsClassifiedByKeyword', 'classify'],
        "Schema & System Architecture": ['createComponentSchema', 'createMetadataSchema', 'createEmbeddedSchema', 'createBundleSchema', 'createRegionSchema', 'createMultimediaSchema', 'updateSchemaFieldProperties', 'updateSchemaFieldStructure', 'getComponentTemplateLinks', 'getIsComponentTemplateRequired', 'getSchemaLinks'],
        "Versioning & History": ['checkOutItem', 'checkInItem', 'undoCheckOutItem', 'rollbackItem', 'getItemHistory', 'getUsedByHistory', 'getUsesForVersion'],
        "Workflow & Tasks": ['startWorkflow', 'getActivities', 'startActivity', 'finishActivity', 'reassignActivity', 'restartActivity', 'forceFinishProcess', 'revertProcess', 'createProcessDefinition', 'updateProcessDefinition', 'getProcessDefinitions', 'getApprovalStatuses'],
        "Publishing & Delivery": ['publish', 'unpublish', 'getPublishTransactions', 'getPublishInfo', 'getTargetTypes'],
        "BluePrint & Global Hierarchy": ['createPublication', 'updatePublication', 'getPublications', 'getPublicationTypes', 'createBluePrintHierarchy', 'createRootStructureGroup', 'localizeItem', 'unlocalizeItem', 'promoteItem', 'demoteItem', 'getDependencyGraph', 'getRelatedBluePrintItems'],
        "AI & Multimedia Processing": ['autoClassifyItem', 'autoClassifyMultimediaComponent', 'createMultimediaComponentFromPrompt', 'createMultimediaComponentFromAttachment', 'createMultimediaComponentFromBase64', 'createMultimediaComponentFromUrl', 'readMultimediaComponent', 'splitWordMultimediaComponentIntoTextAndImages', 'splitPowerPointMultimediaComponentIntoTextAndImages', 'generateContentFromPrompt', 'updateMultimediaComponentFromPrompt', 'getMultimediaTypes'],
        "Orchestration & Automation": ['toolOrchestrator', 'readUploadedFile'],
        "System & User Administration": ['getUserProfile', 'updateUserProfile', 'getUsers']
    };

    const summary: string[] = [];
    const categorizedSet = new Set<string>();

    for (const [categoryName, toolNames] of Object.entries(categories)) {
        summary.push(`### ${categoryName}`);
        let addedInCategory = false;
        for (const name of toolNames) {
            const tool = toolRegistry.get(name);
            if (tool) {
                summary.push(`- **${name}**: ${tool.summary}`);
                categorizedSet.add(name);
                addedInCategory = true;
            }
        }
        if (!addedInCategory) {
            summary.push(`(No tools matched in this category)`);
        }
        summary.push("");
    }

    const uncategorized: string[] = [];
    for (const [name, tool] of toolRegistry.entries()) {
        if (!categorizedSet.has(name)) {
            uncategorized.push(`- **${name}**: ${tool.summary}`);
        }
    }

    if (uncategorized.length > 0) {
        summary.push(`### Other Tools`);
        summary.push(...uncategorized);
    }

    return summary.join('\n');
}
