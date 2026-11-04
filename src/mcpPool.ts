import { McpConnection, McpServerConfig, McpTool, toolName } from "./mcpClient";
import type { ToolDefinition } from "./ollamaClient";

/** Tool definitions use up the context window on every request. */
export const MAX_TOOLS = 20;
/** A broken server shouldn't delay every request, so it's tried again only after this long. */
const RETRY_AFTER_MS = 60000;

export interface McpLog {
  info(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  debug(text: string): void;
}

interface RunningServer {
  connection: McpConnection;
  tools: McpTool[];
}

interface RegisteredTool {
  connection: McpConnection;
  tool: McpTool;
  definition: ToolDefinition;
}

export interface McpToolList {
  tools: ToolDefinition[];
  /** Servers that failed to start since this was last asked. */
  failed: string[];
  /** Tools left out by the limit. Empty unless that list has changed. */
  skipped: string[];
}

/** Takes one tool from each server in turn, so a large server can't crowd out the others. */
export function shareTools<T>(lists: T[][], limit: number): { kept: T[]; skipped: T[] } {
  const kept: T[] = [];
  const skipped: T[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let round = 0; round < longest; round++) {
    for (const list of lists) {
      if (round < list.length) {
        (kept.length < limit ? kept : skipped).push(list[round]);
      }
    }
  }
  return { kept, skipped };
}

/** Keeps the configured servers running, and offers their tools to Agent. */
export class McpPool {
  private servers = new Map<string, RunningServer>();
  private registered = new Map<string, RegisteredTool>();
  private retryAt = new Map<string, number>();
  private failures: string[] = [];
  private skipped: string[] = [];
  private reportedSkipped = "";
  private loading: Promise<void> | undefined;
  private generation = 0;

  constructor(
    private readonly configured: () => Record<string, McpServerConfig>,
    private readonly cwd: () => string | undefined,
    private readonly log: McpLog,
    private readonly retryAfterMs = RETRY_AFTER_MS,
  ) {}

  private async start(server: string, config: McpServerConfig, generation: number): Promise<void> {
    const connection = new McpConnection(config, this.cwd(), (text) => this.log.debug(`MCP ${server}: ${text}`));
    try {
      await connection.connect();
      const tools = await connection.listTools();
      if (generation !== this.generation) {
        connection.close();
        return;
      }
      this.servers.set(server, { connection, tools });
      this.retryAt.delete(server);
      this.log.info(`MCP server ${server} is ready with ${tools.length} tool(s).`);
    } catch (error) {
      connection.close();
      if (generation === this.generation) {
        this.failures.push(server);
        this.retryAt.set(server, Date.now() + this.retryAfterMs);
        this.log.error(`MCP server ${server} didn't start: ${String(error)}`);
      }
    }
  }

  private register(names: string[]): void {
    const lists = names.map((server) => {
      const running = this.servers.get(server) as RunningServer;
      return running.tools.map((tool) => ({ name: toolName(server, tool.name), connection: running.connection, tool }));
    });
    const { kept, skipped } = shareTools(lists, MAX_TOOLS);
    this.registered.clear();
    this.skipped = skipped.map((entry) => entry.name);
    for (const { name, connection, tool } of kept) {
      if (this.registered.has(name)) {
        this.skipped.push(name);
        continue;
      }
      this.registered.set(name, {
        connection,
        tool,
        definition: { type: "function", function: { name, description: tool.description ?? tool.name, parameters: tool.inputSchema ?? { type: "object" } } },
      });
    }
    for (const name of this.skipped) {
      this.log.warn(`Skipped MCP tool ${name}: only ${MAX_TOOLS} tools can be offered to a model.`);
    }
  }

  /** Starts servers that aren't running, except ones that failed moments ago. */
  private async refresh(): Promise<void> {
    const generation = this.generation;
    const configured = Object.entries(this.configured());
    const starts: Array<Promise<void>> = [];
    for (const [server, config] of configured) {
      const running = this.servers.get(server);
      if (running?.connection.running) {
        continue;
      }
      if (running) {
        this.servers.delete(server);
        this.log.warn(`MCP server ${server} stopped, so it's being restarted.`);
      }
      if (Date.now() >= (this.retryAt.get(server) ?? 0)) {
        starts.push(this.start(server, config, generation));
      }
    }
    await Promise.all(starts);
    if (generation === this.generation) {
      this.register(configured.map(([server]) => server).filter((server) => this.servers.has(server)));
    }
  }

  private ensure(): Promise<void> {
    this.loading ??= this.refresh().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  async definitions(): Promise<McpToolList> {
    await this.ensure();
    const failed = this.failures;
    this.failures = [];
    const skipped = this.skipped.join(",");
    const changed = skipped !== this.reportedSkipped;
    this.reportedSkipped = skipped;
    return { tools: [...this.registered.values()].map((entry) => entry.definition), failed, skipped: changed ? this.skipped : [] };
  }

  has(name: string): boolean {
    return this.registered.has(name);
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (!this.registered.has(name)) {
      return `Unknown MCP tool: ${name}`;
    }
    // Only a call that hasn't been sent is safe to send to a restarted server.
    if (!this.registered.get(name)?.connection.running) {
      await this.ensure();
    }
    const entry = this.registered.get(name);
    if (!entry) {
      return `The MCP server for ${name} isn't running.`;
    }
    this.log.info(`MCP call ${name}: ${JSON.stringify(args).slice(0, 500)}`);
    return entry.connection.callTool(entry.tool.name, args, signal);
  }

  stop(): void {
    this.generation++;
    this.servers.forEach((server) => server.connection.close());
    this.servers.clear();
    this.registered.clear();
    this.retryAt.clear();
    this.skipped = [];
    this.reportedSkipped = "";
  }
}
