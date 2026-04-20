# Tridion Sites MCP Server

This repository contains a Model Context Protocol (MCP) server designed to integrate Tridion Sites with AI assistants like GitHub Copilot and Gemini CLI. By running this server, you transform your AI assistant into a BluePrint-aware collaborator capable of navigating complex content hierarchies, executing system administration tasks, and orchestrating batch operations via the Tridion Sites Core Service REST API.

## Optimized Architecture: Just-In-Time (JIT) Hydration

This server uses a **discovery-based architecture** to minimize token consumption and prevent agent hallucinations. Instead of exposing all 80+ tools in the initial system prompt, the server uses a **JIT Hydration** model:

1.  **`_setTools`**: The primary meta-tool used to **hydrate and register** the required CMS tools into the host registry. Once configured, the full tool documentation (including schemas and heuristics) becomes natively available for use. This tool performs an **exclusive refresh**: each call replaces the current hydrated set with a new one.
2.  **Reconciliation Receipt**: Upon initialization, the server returns a "Reconciliation Receipt" that confirms the verified state of the registry and provides a task-continuation bridge.
3.  **Protocol Synchronization**: To ensure the host has processed the tool refresh, the AI concludes its response after initialization. The updated tools are then fully available in the subsequent turn.
4.  **Security Interlock**: For orchestrated scripts (`toolOrchestrator`), the server enforces a strict rule: a tool cannot be executed within a script unless it has been explicitly initialized in the current session.

This approach is an independent implementation of the **MCP Compression** pattern, which ensures the system prompt stays efficient while providing the agent with the highest-fidelity documentation exactly when needed.

### JIT Hydration Handshake
The agent performs a "Discovery Handshake" before executing specialized tools:

1.  **Select Tools**: AI selects required tools from the `AVAILABLE TOOLS` list in the `_setTools` description.
2.  **Hydrate**: AI calls `_setTools(toolNames: ["getItem", "search"], resumeTask: "...")`.
3.  **Sync**: AI calls `_setTools(resumeTask: "...")` without tool names to synchronize the registry.
4.  **Execute**: AI proceeds to use `getItem` or `search` natively in the subsequent turn.

### Why `_setTools`?
-   **Security**: Agents cannot execute tools without explicitly requesting documentation for them first.
-   **Context Efficiency**: The LLM context is not cluttered with 80+ tool definitions; it only holds those required for the current task.
-   **Consistency**: Using `_setTools` natively keeps the LLM's world-view synchronized with the actual server capabilities.



## Capabilities

This server exposes over 80 tools covering all major areas of Tridion Sites content management. The table below summarises what the AI assistant can do on your behalf once connected.

| Domain | Available Operations |
|---|---|
| **Content Discovery** | Search items; retrieve full item details and version history; browse container contents; inspect dependency graphs, publish info, and lock status |
| **Content Creation** | Create components, pages, publications, structure groups, and multimedia components (from a URL, base64 data, file attachment, or an AI-generated prompt) |
| **Content Editing** | Update component content, page layouts, item properties, metadata, and publication settings |
| **Content Organization** | Copy or move items between containers within a publication; delete items or specific historical versions |
| **Schema Management** | Create and modify component, embedded, metadata, bundle, multimedia, and region schemas |
| **Version Control** | Check out / in items, undo checkouts, and roll back to prior versions |
| **Publishing** | Publish and unpublish items to configured targets; monitor and query publish transactions |
| **Workflow** | Start, assign, finish, and restart individual workflow activities; force-finish or revert entire workflow process instances; manage process definitions and approval statuses |
| **Taxonomy & Classification** | Classify items with keywords, browse category trees, and auto-classify items or multimedia components using AI |
| **BluePrint & Localization** | Visualize and create BluePrint hierarchies; localize and unlocalize items; promote and demote items to parent or child publications |
| **Multimedia** | Read binary content and split Word / PowerPoint documents into structured components and images |
| **User Management** | Retrieve and update user profiles; list CMS users |
| **AI-Powered Generation** | Generate component content, create or update multimedia from natural language prompts *(requires a configured Gemini API key)* |
| **Orchestration** | Execute complex multi-step operations via the `toolOrchestrator`, which runs sandboxed scripts with access to all other tools — enabling conditional logic, loops, and batch processing |

---

## Prerequisites

Before running the server, ensure you have the following installed:
* [Node.js](https://nodejs.org/) and npm
* Access to a Tridion Sites CMS instance

---

## 1. Local Server Setup

To get the MCP server running on your machine, follow these steps:

1. **Download/Clone the repository:** Ensure you have the latest version of the codebase on your local machine.
   ```bash
   git clone <your-repository-url>
   cd <your-repository-directory>
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Obtain Service Account Credentials:**
   To authenticate the server against the CM REST API, you need a valid Client ID and Secret.
   * Log in to your Tridion Sites **Access Management** console.
   * Navigate to the **Service accounts** tab.
   * Locate and click on the relevant service account for your environment (e.g., **Tridion Sites Content Manager API Client (admin)**).
   * From the details screen, copy your **Client ID** and generate/copy your **Client Secret**.

4. **Configure Environment Variables:**
   Set the following environment variables using the credentials you just obtained.
   *(Note: The URLs below are examples and should be updated to match your target CMS environment).*

   ```env
   CORE_API_URL=http://your-cms-host/api/v3.0
   AUTH_TOKEN_URL=http://your-auth-host/access-management/connect/token
   AUTH_CLIENT_ID=<your-client-id>
   AUTH_CLIENT_SECRET=<your-client-secret>
   GEMINI_API_KEY=<your-gemini-api-key>
   MAX_PAYLOAD_SIZE=31457280
   ```

   > **Note on `MAX_PAYLOAD_SIZE`:** This variable defines the maximum body size (in bytes) for incoming POST requests to the Streamable HTTP server. The default is **30MB** (31,457,280 bytes). If you frequently work with very large multimedia files (e.g., high-resolution images or large PDFs) that exceed this limit when Base64 encoded, you should increase this value to prevent `413 Payload Too Large` errors.

   > **Note on `GEMINI_API_KEY`:** This key is only required if you intend to use the AI-powered tools (`autoClassifyItem`, `autoClassifyMultimediaComponent`, `generateContentFromPrompt`, `createMultimediaComponentFromPrompt`, `updateMultimediaComponentFromPrompt`). It is also required by `readMultimediaComponent` and `readUploadedFile` when reading **image** files (the vision model is used to analyse the image content; non-image formats such as Word, Excel, and PDF do not require the key). All other tools work without it. Obtain a key from [Google AI Studio](https://aistudio.google.com/).

   > **Windows tip:** To set variables persistently (so they survive terminal sessions and reboots), use **System Properties** instead of setting them in the terminal:
   > 1. Open **Start**, search for **"Edit the system environment variables"**, and open it.
   > 2. Click **Environment Variables…** and add each variable under **User variables**.
   > 3. Click **OK** on all dialogs, then open a **new terminal** before continuing.
   >
   > Alternatively, set them temporarily in PowerShell for the current session:
   > ```powershell
   > $env:CORE_API_URL = "http://..."
   > $env:AUTH_TOKEN_URL = "http://..."
   > $env:AUTH_CLIENT_ID = "<your-client-id>"
   > $env:AUTH_CLIENT_SECRET = "<your-client-secret>"
   > ```

5. **Start the server:**
   
   The server automatically detects the correct transport mode.

   **Standard Mode (Stdio):**
   Automatically used when the server is launched by an AI agent (Gemini CLI, Claude, VS Code). To force this mode in a terminal for testing:
   ```bash
   npm run start:stdio
   ```

   **Streamable HTTP Mode:**
   Automatically used when the server is run directly in a terminal for manual testing:
   ```bash
   npm run start:http
   ```
   *(Note: You can also just run `npm start`; it will automatically detect the interactive terminal and default to HTTP).*

    **Configuration Toggles:**
    You can toggle features via CLI flags, environment variables, or a local `.env` file. When using `npm start`, remember to use the `--` separator to pass flags through to the underlying process:


    *   **Transport Mode Override**
        *   Force HTTP: `npm start -- --http` or `MCP_TRANSPORT=http`
        *   Force Stdio: `npm start -- --stdio` or `MCP_TRANSPORT=stdio`

---

## 2. Project Structure

```
src/
├── index.ts              # Server entry point. Registers the _setTools handler.
├── mcp/
│   └── metaTools.ts      # Core JIT hydration architecture. Defines the _setTools meta-tool and 
│                         # manages session-isolated state for dynamic tool registration.
├── tools/                # One file per MCP tool. Each file exports a single object with a name,
│                         # description, Zod input schema, and an execute function.
├── schemas/              # Reusable Zod schemas shared across multiple tools (e.g. search query
│                         # parameters, link structures, field value shapes, XML name rules).
└── utils/                # Shared helper modules used by tools:
    ├── axios.ts          # Authenticated Axios instance. Handles OAuth token acquisition and
    │                     # caching, and injects the correct Authorization header on every request.
    ├── errorUtils.ts     # Standardises error responses returned from tool execute functions.
    ├── responseFiltering.ts  # Trims large CMS responses to keep LLM context usage low.
    └── ...               # Other helpers for page layout, link resolution, language handling, etc.
```

## 3. Integration Examples

The Tridion Sites MCP server can be integrated into various AI environments. Each environment supports both **Stdio** (local subprocess) and **HTTP** (network service) transports.

### VS Code (GitHub Copilot)
VS Code uses an `mcp.json` file (either globally in your user profile or locally in a `.vscode/` folder).

#### Stdio Mode (Process)
```json
{
  "servers": {
    "tridion": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/src/index.ts"],
      "env": {
        "CORE_API_URL": "...",
        "AUTH_CLIENT_ID": "...",
        "AUTH_CLIENT_SECRET": "...",
        "AUTH_TOKEN_URL": "..."
      }
    }
  }
}
```

#### HTTP Mode (Streamable)
Ensure the server is running locally first (`npm start`).
```json
{
  "servers": {
    "tridion": {
      "url": "http://localhost:8090"
    }
  }
}
```

---

### Gemini CLI
Gemini CLI uses a `settings.json` file to register MCP servers.
Note: you may need to use absolute paths for the command arguments.

#### Stdio Mode (Process)
```json
{
  "mcpServers": {
    "tridion": {
      "command": "npx",
      "args": [
        "tsx",
        "/Users/YOUR_USER/path/to/src/index.ts"
      ],
      "env": {
        "CORE_API_URL": "...",
        "AUTH_CLIENT_ID": "..."
      }
    }
  }
}
```

#### HTTP Mode (Streamable)
```json
{
  "mcpServers": {
    "tridion": {
      "httpUrl": "http://localhost:8090"
    }
  }
}
```

---

### Google Antigravity
Antigravity uses an `mcp_config.json` file.

#### Stdio Mode (Process)
```json
{
  "mcpServers": {
    "tridion": {
      "command": "/opt/homebrew/bin/node",
      "args": [
        "--import",
        "/Users/YOUR_USER/path/to/node_modules/tsx/dist/loader.mjs",
        "/Users/YOUR_USER/path/to/src/index.ts"
      ],
      "env": {
        "CORE_API_URL": "...",
        "AUTH_CLIENT_ID": "..."
      }
    }
  }
}
```

#### HTTP Mode (Streamable)
```json
{
  "mcpServers": {
    "tridion": {
      "serverUrl": "http://localhost:8090"
    }
  }
}
```

---

---

## 4. Development & Testing (Mock Server)

This repository includes a standalone **Tridion Mock Server** (`tridion-mock-server.js`) that allows you to develop and test MCP tool configurations without requiring a live Tridion Sites environment.

### Starting the Mock Server

To launch the mock server on your local machine:

```bash
node tridion-mock-server.js 8081
```

Once started, the mock server provides a simulated CM REST API and Access Management endpoint at `http://localhost:8081`.

### Starting the MCP Server with Mock Data

You can quickly start the MCP server in HTTP mode, pre-configured to point to the local mock instance, by running:

```bash
npm run start:mock
```

This script automatically sets the `CORE_API_URL` and `AUTH_TOKEN_URL` to target the mock server without requiring manual environment variable configuration.

### Mock Server Configuration

To point your MCP server at the mock instance, use the following environment variable configuration in your `mcp.json` or `.env` file:

```json
"env": {
    "CORE_API_URL": "http://localhost:8081/api/v3.0",
    "AUTH_TOKEN_URL": "http://localhost:8081/access-management/connect/token",
    "AUTH_CLIENT_ID": "any-id",
    "AUTH_CLIENT_SECRET": "any-secret"
}
```

> [!TIP]
> The mock server is stateless and accepts any Client ID/Secret. It is pre-seeded with a basic BluePrint hierarchy (System Master, Content Master, Website EN) and several common schemas (Article, Address, etc.) to facilitate immediate tool testing.

---

## 5. Troubleshooting

### "Connection closed" or "Disconnected" in Stdio Mode
If the server fails to connect in Gemini CLI or Claude Desktop ensure the path to `src/index.ts` in your config is absolute (e.g., `/Users/name/...`). Relative paths often fail because the CLI launches from its own application directory.

### The AI Assistant returns an `invalid_client` authentication error
If the MCP server is running but the assistant reports that calls to the CMS are failing with an `invalid_client` error, the Tridion authentication server is rejecting your credentials. Check the following:

1. **VS Code Stale Terminals (Most Common):** If you recently set or updated your environment variables locally, **any currently open VS Code terminals will not see the new values**. 
   * **Fix:** You must completely kill the terminal session by clicking the **Trash Can icon** in the terminal panel, open a new terminal, and run `npm run start` again.
   * **Verify:** In your new VS Code terminal, you can verify the variable was picked up by running:
     * *PowerShell:* `echo $env:AUTH_CLIENT_ID`
     * *Bash/Zsh:* `echo $AUTH_CLIENT_ID`

2. **Old or Revoked Credentials:** Ensure you are using the correct secret for the specific environment URL (`AUTH_TOKEN_URL`) you are targeting. If you are copying a secret shared by a colleague, it may have been regenerated or revoked in Access Management. Generate a fresh secret if necessary.

---

### The server fails to start: `EADDRINUSE` (port already in use)

If `npm start` exits immediately with an `EADDRINUSE` error, another process is already using port 8090 (often a previous server instance that was not cleanly stopped).

* **Kill the conflicting process** (PowerShell):
  ```powershell
  Get-Process -Id (Get-NetTCPConnection -LocalPort 8090).OwningProcess | Stop-Process
  ```
* Then re-run `npm run start`.

---

### The AI assistant reports it cannot reach the CMS (network/timeout errors)

1. Confirm the CMS is reachable from your machine by opening `CORE_API_URL` in a browser or running:
   ```powershell
   Invoke-WebRequest -Uri $env:CORE_API_URL -UseBasicParsing
   ```
2. Check that no VPN, firewall, or proxy is blocking outbound HTTP requests to the CMS host.
3. If you are targeting a CMS on a private network, ensure your machine is connected to the appropriate VPN or internal network.

---

### Tools are missing or not visible in the AI assistant

* **GitHub Copilot:** The connection is established automatically when you ask a question that requires the MCP tools — no manual action is needed. If the tools are still not available, open the `mcp.json` file and click **Restart** in the CodeLens overlay. Note that this button only reconnects VS Code to the server; which must already be running (`npm run start`) for it to succeed.
* **Gemini CLI:** After saving changes to `settings.json`, restart the Gemini application completely. Run `/mcp list` in the chat to confirm the server is connected.

---

### Gemini CLI shows the MCP server as "disconnected"

Gemini CLI attempts to connect to all configured MCP servers **once at startup**. If the server was not running at the time the CLI was launched, the connection fails for that session.

**Fix:** Start `npm start` first and then launch Gemini CLI, or — if the CLI is already open — start the server and then run `/mcp reload` in the Gemini CLI chat to reconnect without restarting.
