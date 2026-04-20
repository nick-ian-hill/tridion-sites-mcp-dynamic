const args = process.argv.slice(2);
const forceHttp = args.includes('--http');
const forceStdio = args.includes('--stdio');

// Dynamic detection: defaults to HTTP in terminal, Stdio when piped/spawned by agent
const defaultTransport = process.stdin.isTTY ? 'http' : 'stdio';
const transportType = (process.env.MCP_TRANSPORT || (forceHttp ? 'http' : (forceStdio ? 'stdio' : defaultTransport))).toLowerCase();
const isStdio = transportType === 'stdio';


/**
 * In Stdio mode, stdout MUST be reserved for MCP JSON-RPC protocol messages.
 * We intercept all writes to process.stdout and only allow valid JSON-RPC
 * messages through. Everything else is redirected to stderr.
 */
if (isStdio) {
    // Redirect all standard logging to stderr to keep stdout clean for the MCP protocol.
    // The MCP StdioServerTransport writes directly to process.stdout, so it is unaffected.
    console.log = (...args) => console.error(...args);
    console.info = (...args) => console.error(...args);
    console.warn = (...args) => console.error(...args);
}

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { initializeToolRegistry, Tool } from './utils/toolRegistry.js';
import { initializeSessionTools } from './mcp/metaTools.js';
import { toolOrchestrator } from './tools/toolOrchestrator.js';

/**
 * Creates and configures an McpServer instance with registered meta-tools.
 * The server is initialized with listChanged: true capabilities to support JIT Hydration.
 */
function createMcpServer(): McpServer {
    const server = new McpServer({
        name: "tridion-sites-mcp-server",
        version: "0.1.0"
    }, {
        capabilities: {
            tools: {
                listChanged: true
            }
        }
    });

    // 1. Initialize session-specific meta-tools and state
    const { _setTools, unlockedTools } = initializeSessionTools(server);

    // 2. Initial toolset: Only _setTools is registered by default.
    // All other tools (including toolOrchestrator) must be hydrated via _setTools.
    const mcpTools = [_setTools as Tool];

    for (const tool of mcpTools) {
        let fullDescription = `${tool.summary}\n\n${tool.description}`;
        
        // Append examples if they exist (standard for the JIT registration pattern)
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
                // We pass the session-isolated 'unlockedTools' Set into the execution context
                // so the toolOrchestrator can enforce the "Initialization Interlock".
                return tool.execute(args, { ...context, unlockedTools });
            }
        );
    }

    return server;
}

/**
 * Main entry point. Supports Stdio and Streamable HTTP transports.
 * Automatically detects transport based on TTY status (Stdio when piped).
 */
async function startServer() {

    // 1. Initialize the tool registry (loads all tools from src/tools/)
    // This takes ~2-3s but MUST happen before we register capabilities/connect
    // because the MCP SDK doesn't allow registering tools after a connection is active.
    // Our global stdout interception ensures this internal logging doesn't break Stdio.
    await initializeToolRegistry([]);

    if (transportType === 'stdio') {
        // --- Stdio Transport (Standard for CLI and Desktop integrations) ---
        const server = createMcpServer();
        const transport = new StdioServerTransport();

        console.error("Connecting Tridion Sites MCP Server (Stdio)...");
        await server.connect(transport);
        console.error("Server connected.");
    } else {
        // --- Streamable HTTP Transport (Legacy/SSE support) ---
        const sessions = new Map<string, StreamableHTTPServerTransport>();
        const port = process.env.PORT ? parseInt(process.env.PORT) : 8090;

        const httpServer = http.createServer(async (req, res) => {
            // Standard CORS for local development UI access if needed
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, mcp-session-id');

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            const sessionId = req.headers['mcp-session-id'] as string | undefined;

            if (req.method === 'POST') {
                let body = '';
                const MAX_PAYLOAD_SIZE = process.env.MAX_PAYLOAD_SIZE 
                    ? parseInt(process.env.MAX_PAYLOAD_SIZE) 
                    : 30 * 1024 * 1024; // 30MB default
                let tooLarge = false;

                req.on('data', chunk => { 
                    if (tooLarge) return;
                    body += chunk.toString(); 
                    if (body.length > MAX_PAYLOAD_SIZE) {
                        tooLarge = true;
                        res.writeHead(413, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Payload too large. Limit is ' + (MAX_PAYLOAD_SIZE / 1024 / 1024) + 'MB' }));
                        req.destroy();
                    }
                });

                req.on('end', async () => {
                    if (tooLarge) return;
                    let parsed: any;
                    try {
                        parsed = JSON.parse(body);
                    } catch (e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid JSON' }));
                        return;
                    }

                    if (sessionId && sessions.has(sessionId)) {
                        // Existing session
                        await sessions.get(sessionId)!.handleRequest(req, res, parsed);
                    } else if (isInitializeRequest(parsed)) {
                        // New session
                        const transport = new StreamableHTTPServerTransport({
                            sessionIdGenerator: () => randomUUID(),
                            onsessioninitialized: (newSessionId) => {
                                sessions.set(newSessionId, transport);
                            }
                        });
                        transport.onclose = () => {
                            const sid = transport.sessionId;
                            if (sid) sessions.delete(sid);
                        };
                        const server = createMcpServer();
                        await server.connect(transport);
                        await transport.handleRequest(req, res, parsed);
                    } else if (sessionId && !sessions.has(sessionId)) {
                        // Stale session ID with a non-initialize request (e.g. after server restart).
                        // Under the JIT Hydration model, we DO NOT support stateless fallbacks.
                        // Tools must be re-initialized by the client after a connection reset.
                        // Returning 404 signals the client to re-initialize the session properly.
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Session not found. Please re-initialize.' }));
                    } else {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Session not found or invalid request' }));
                    }
                });
            } else if (req.method === 'GET' || req.method === 'DELETE') {
                if (sessionId && sessions.has(sessionId)) {
                    await sessions.get(sessionId)!.handleRequest(req, res);
                } else if (sessionId && !sessions.has(sessionId)) {
                    // Stale session ID — 404 signals clients to re-initialize
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Session not found' }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Bad request: missing session ID' }));
                }
            } else {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Method not allowed' }));
            }
        });

        httpServer.listen(port, () => {
            console.error(`Tridion Sites MCP Server listening (Streamable HTTP) on port ${port}`);
        });
    }
}

startServer().catch((error) => {
    console.error("Fatal error starting server:", error);
    process.exit(1);
});