import { ChildProcessWithoutNullStreams, spawn } from "child_process";

const PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05"]);
const CONNECT_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 60000;
const EXIT_GRACE_MS = 1500;
const MAX_NAME_LENGTH = 64;

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** Makes one name from a server and a tool, using only characters models accept. */
export function toolName(server: string, tool: string): string {
  return `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_NAME_LENGTH);
}

/** Turns an MCP tool result into text for the model. */
export function resultText(result: unknown): string {
  const body = result as { content?: Array<Record<string, unknown>>; isError?: boolean };
  const parts = (body.content ?? []).map((item) => {
    if (item.type === "text") {
      return String(item.text ?? "");
    }
    if (item.type === "resource") {
      const resource = item.resource as { uri?: string; text?: string };
      return resource.text ?? `[Resource ${resource.uri ?? ""}]`;
    }
    if (item.type === "resource_link") {
      return `[Link ${String(item.uri ?? "")}]`;
    }
    return `[${String(item.type)} content isn't shown]`;
  });
  const text = parts.join("\n") || "(no output)";
  return body.isError ? `The tool reported an error:\n${text}` : text;
}

/**
 * Windows can't start npx.cmd or other scripts directly, so they go through cmd.exe.
 * The arguments are quoted here because they mustn't be read as shell syntax.
 */
export function spawnPlan(config: McpServerConfig, platform: NodeJS.Platform = process.platform): { command: string; args: string[]; verbatim: boolean } {
  const args = config.args ?? [];
  if (platform !== "win32" || /\.(exe|com)$/i.test(config.command)) {
    return { command: config.command, args, verbatim: false };
  }
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  const quote = (arg: string): string => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`.replace(meta, "^$1");
  const line = [config.command.replace(meta, "^$1"), ...args.map(quote)].join(" ");
  return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/** One running MCP server, connected over stdio with newline-delimited JSON-RPC. */
export class McpConnection {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private nextId = 1;
  private exited = false;

  constructor(
    config: McpServerConfig,
    cwd: string | undefined,
    private readonly onLog: (text: string) => void = () => undefined,
  ) {
    const plan = spawnPlan(config);
    this.process = spawn(plan.command, plan.args, { cwd, env: { ...process.env, ...config.env }, stdio: "pipe", windowsVerbatimArguments: plan.verbatim });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => this.onLog(chunk.trim()));
    this.process.stdin.on("error", () => undefined);
    this.process.on("error", (error) => this.fail(error));
    this.process.on("exit", () => this.fail(new Error("The MCP server stopped.")));
  }

  get running(): boolean {
    return !this.exited;
  }

  private fail(error: Error): void {
    this.exited = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private send(message: Record<string, unknown>): void {
    if (!this.exited) {
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    }
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines.filter((text) => text.trim())) {
      try {
        this.handle(JSON.parse(line) as RpcMessage);
      } catch {
        this.onLog(`Ignored an unreadable message: ${line.slice(0, 200)}`);
      }
    }
  }

  private handle(message: RpcMessage): void {
    if (message.method) {
      // This client offers no optional features, so ping is the only request it answers.
      if (message.id !== undefined) {
        this.send(message.method === "ping" ? { id: message.id, result: {} } : { id: message.id, error: { code: -32601, message: "Method not found" } });
      }
      return;
    }
    const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(message.id as number);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "The MCP server returned an error."));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(new Error("The MCP server isn't running."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cancel = (reason: string): void => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          this.send({ method: "notifications/cancelled", params: { requestId: id, reason } });
          reject(new Error(reason));
        }
      };
      const onAbort = (): void => cancel("Stopped by the user.");
      const timer = setTimeout(() => cancel(`${method} timed out.`), timeoutMs);
      const finish = (action: () => void): void => {
        signal?.removeEventListener("abort", onAbort);
        action();
      };
      this.pending.set(id, { timer, resolve: (value) => finish(() => resolve(value)), reject: (error) => finish(() => reject(error)) });
      signal?.addEventListener("abort", onAbort);
      this.send({ id, method, params });
    });
  }

  async connect(): Promise<void> {
    const result = (await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "astute-chat", version: "1.0.0" } },
      CONNECT_TIMEOUT_MS,
    )) as { protocolVersion?: string };
    if (!SUPPORTED_VERSIONS.has(result.protocolVersion ?? "")) {
      throw new Error(`Unsupported MCP version ${String(result.protocolVersion)}.`);
    }
    this.send({ method: "notifications/initialized" });
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.request("tools/list", cursor ? { cursor } : {}, CONNECT_TIMEOUT_MS)) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    return resultText(await this.request("tools/call", { name, arguments: args }, CALL_TIMEOUT_MS, signal));
  }

  /** Follows the spec's order: close stdin, then SIGTERM, then SIGKILL. */
  close(): void {
    this.process.stdin.end();
    setTimeout(() => {
      if (!this.exited) {
        this.process.kill("SIGTERM");
      }
    }, EXIT_GRACE_MS).unref();
    setTimeout(() => {
      if (!this.exited) {
        this.process.kill("SIGKILL");
      }
    }, EXIT_GRACE_MS * 2).unref();
  }
}
