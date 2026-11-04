import * as vscode from "vscode";
import { McpConnection, McpServerConfig, McpTool, toolName } from "./mcpClient";
import type { ToolDefinition } from "./ollamaClient";

/** Tool definitions use up the context window on every request. */
const MAX_TOOLS = 20;

interface RegisteredTool {
  connection: McpConnection;
  tool: McpTool;
  definition: ToolDefinition;
}

/**
 * Starts the servers in the user's settings the first time Agent needs them.
 * They run as local programs, so servers can't come from a workspace.
 */
export class McpManager implements vscode.Disposable {
  private connections: McpConnection[] = [];
  private registered = new Map<string, RegisteredTool>();
  private loading: Promise<void> | undefined;
  private failures: string[] = [];
  private readonly subscription: vscode.Disposable;

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("astuteChat.mcp.servers")) {
        this.stop();
      }
    });
  }

  private async load(): Promise<void> {
    const servers = vscode.workspace.getConfiguration("astuteChat").get<Record<string, McpServerConfig>>("mcp.servers", {});
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    for (const [server, config] of Object.entries(servers)) {
      const connection = new McpConnection(config, cwd, (text) => this.log.debug(`MCP ${server}: ${text}`));
      try {
        await connection.connect();
        const tools = await connection.listTools();
        this.connections.push(connection);
        for (const tool of tools) {
          const name = toolName(server, tool.name);
          if (this.registered.size >= MAX_TOOLS) {
            this.log.warn(`Skipped MCP tool ${name}: only ${MAX_TOOLS} tools can be offered to a model.`);
            continue;
          }
          this.registered.set(name, {
            connection,
            tool,
            definition: { type: "function", function: { name, description: tool.description ?? tool.name, parameters: tool.inputSchema ?? { type: "object" } } },
          });
        }
        this.log.info(`MCP server ${server} is ready with ${tools.length} tool(s).`);
      } catch (error) {
        connection.close();
        this.failures.push(server);
        this.log.error(`MCP server ${server} didn't start: ${String(error)}`);
      }
    }
  }

  /** Tool definitions for Agent mode, and the servers that failed since this was last asked. */
  async definitions(): Promise<{ tools: ToolDefinition[]; failed: string[] }> {
    this.loading ??= this.load();
    await this.loading;
    const failed = this.failures;
    this.failures = [];
    return { tools: [...this.registered.values()].map((entry) => entry.definition), failed };
  }

  has(name: string): boolean {
    return this.registered.has(name);
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const entry = this.registered.get(name);
    if (!entry) {
      return `Unknown MCP tool: ${name}`;
    }
    this.log.info(`MCP call ${name}: ${JSON.stringify(args).slice(0, 500)}`);
    return entry.connection.callTool(entry.tool.name, args, signal);
  }

  private stop(): void {
    this.connections.forEach((connection) => connection.close());
    this.connections = [];
    this.registered.clear();
    this.loading = undefined;
  }

  dispose(): void {
    this.stop();
    this.subscription.dispose();
  }
}
