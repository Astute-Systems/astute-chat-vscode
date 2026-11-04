import * as http from "http";
import * as https from "https";
import { StringDecoder } from "string_decoder";

export interface ToolCall {
  type?: "function";
  function: {
    index?: number;
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
  /** Base64 image data, without a data URI prefix. */
  images?: string[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  think?: boolean;
  keep_alive?: string;
  options?: { temperature?: number; num_ctx?: number; num_thread?: number };
}

export interface ChatUsage {
  promptTokens?: number;
  outputTokens?: number;
  evalDurationNs?: number;
  doneReason?: string;
}

export interface ChatOutcome {
  content: string;
  thinking: string;
  toolCalls: ToolCall[];
  usage: ChatUsage;
}

export interface ModelInfo {
  name: string;
  size: number;
  /** Runs on another server, so prompts and code leave this one. */
  remote?: boolean;
}

export interface ModelDetails {
  capabilities: string[];
  contextLength?: number;
}

export interface StreamHandlers {
  onThinking?(text: string): void;
  onContent?(text: string): void;
}

export interface StreamOptions {
  signal?: AbortSignal;
  idleTimeoutMs?: number;
}

export type OllamaErrorKind = "connection" | "model-not-found" | "out-of-memory" | "timeout" | "cancelled" | "unsupported" | "server";

export class OllamaError extends Error {
  constructor(
    readonly kind: OllamaErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

function classifyServerError(status: number, body: string): OllamaError {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: string };
    detail = parsed.error ?? detail;
  } catch {
    // Keep the raw body when the server did not send JSON.
  }

  if (status === 404 && /not found/i.test(detail)) {
    return new OllamaError("model-not-found", detail);
  }
  if (status === 401) {
    return new OllamaError("server", "Ollama isn't signed in, which cloud models need. Run `ollama signin` in a terminal, then try again. Cloud models send your prompts and code to Ollama's servers, so you can choose a local model instead.");
  }
  if (/memory/i.test(detail)) {
    return new OllamaError("out-of-memory", `The server ran out of memory: ${detail}`);
  }
  return new OllamaError("server", `Ollama returned ${status}: ${detail || "no details"}`);
}

/** Splits a byte stream into JSON values, one per line, across chunk boundaries. */
export class NdjsonParser {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: Buffer): unknown[] {
    this.buffer += this.decoder.write(chunk);
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown);
  }

  flush(): unknown[] {
    const rest = (this.buffer + this.decoder.end()).trim();
    this.buffer = "";
    return rest ? [JSON.parse(rest) as unknown] : [];
  }
}

interface StreamEvent {
  message?: { content?: string; thinking?: string; tool_calls?: ToolCall[] };
  done?: boolean;
  error?: string;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
}

export class OllamaClient {
  constructor(private readonly baseUrl: string) {}

  private open(path: string, method: string, body: string | undefined, onResponse: (response: http.IncomingMessage) => void, onError: (error: Error) => void): http.ClientRequest {
    const url = new URL(path, this.baseUrl);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      onResponse,
    );
    request.on("error", onError);
    request.end(body);
    return request;
  }

  private connectionError(error: Error): OllamaError {
    return new OllamaError("connection", `Could not connect to Ollama at ${this.baseUrl}. ${error.message || (error as NodeJS.ErrnoException).code || ""}`.trim());
  }

  private requestJson<T>(path: string, body?: unknown, timeoutMs = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      let settled = false;
      const finish = (action: () => void): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          action();
        }
      };

      const request = this.open(
        path,
        body === undefined ? "GET" : "POST",
        payload,
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", (error) => finish(() => reject(this.connectionError(error))));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            finish(() => {
              if ((response.statusCode ?? 500) >= 400) {
                reject(classifyServerError(response.statusCode ?? 500, text));
                return;
              }
              try {
                resolve(JSON.parse(text) as T);
              } catch {
                reject(new OllamaError("server", `${this.baseUrl} did not return valid JSON. Check that it is an Ollama server.`));
              }
            });
          });
        },
        (error) => finish(() => reject(this.connectionError(error))),
      );

      const timer = setTimeout(() => {
        finish(() => reject(new OllamaError("connection", `Timed out connecting to Ollama at ${this.baseUrl}.`)));
        request.destroy();
      }, timeoutMs);
    });
  }

  async version(): Promise<string> {
    const body = await this.requestJson<{ version?: string }>("/api/version");
    return body.version ?? "unknown";
  }

  async listModels(): Promise<ModelInfo[]> {
    const body = await this.requestJson<{ models?: Array<{ name?: string; size?: number; remote_host?: string; remote_model?: string }> }>("/api/tags");
    return (body.models ?? [])
      .filter((model) => model.name)
      .map((model) => {
        const name = model.name as string;
        return { name, size: model.size ?? 0, remote: Boolean(model.remote_host || model.remote_model) || /[:-]cloud$/.test(name) };
      });
  }

  async loadedModels(): Promise<Array<{ name: string; onGpu: boolean }>> {
    const body = await this.requestJson<{ models?: Array<{ name?: string; size_vram?: number }> }>("/api/ps");
    return (body.models ?? []).filter((entry) => entry.name).map((entry) => ({ name: entry.name as string, onGpu: (entry.size_vram ?? 0) > 0 }));
  }

  async isLoaded(model: string): Promise<boolean> {
    return (await this.loadedModels()).some((entry) => entry.name === model);
  }

  /** Frees a model's memory. Ollama unloads a model when keep_alive is 0. */
  async unload(model: string): Promise<void> {
    await this.requestJson("/api/generate", { model, keep_alive: 0 }, 15000);
  }

  async showModel(model: string): Promise<ModelDetails> {
    const body = await this.requestJson<{ capabilities?: string[]; model_info?: Record<string, unknown> }>("/api/show", { model }, 15000);
    const entry = Object.entries(body.model_info ?? {}).find(([key]) => key.endsWith(".context_length"));
    return {
      capabilities: body.capabilities ?? [],
      contextLength: typeof entry?.[1] === "number" ? entry[1] : undefined,
    };
  }

  /**
   * Streams one chat round. The idle timer restarts on every chunk, so a slow
   * model can run for as long as it keeps producing output.
   */
  chat(payload: ChatRequest, handlers: StreamHandlers, options: StreamOptions = {}): Promise<ChatOutcome> {
    return new Promise<ChatOutcome>((resolve, reject) => {
      const outcome: ChatOutcome = { content: "", thinking: "", toolCalls: [], usage: {} };
      const parser = new NdjsonParser();
      const idleMs = options.idleTimeoutMs ?? 600000;
      let finished = false;
      let request: http.ClientRequest | undefined;
      let idleTimer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        clearTimeout(idleTimer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: OllamaError): void => {
        if (!finished) {
          finished = true;
          cleanup();
          request?.destroy();
          reject(error);
        }
      };
      const succeed = (): void => {
        if (!finished) {
          finished = true;
          cleanup();
          resolve(outcome);
        }
      };
      const touch = (): void => {
        clearTimeout(idleTimer);
        if (finished) {
          return;
        }
        idleTimer = setTimeout(() => {
          fail(new OllamaError("timeout", `Ollama sent nothing for ${Math.round(idleMs / 1000)} seconds, so the request was stopped.`));
        }, idleMs);
      };
      const onAbort = (): void => fail(new OllamaError("cancelled", "Stopped."));

      const handle = (value: unknown): void => {
        const event = value as StreamEvent;
        if (event.error) {
          fail(classifyServerError(500, JSON.stringify({ error: event.error })));
          return;
        }
        if (event.message?.thinking) {
          outcome.thinking += event.message.thinking;
          handlers.onThinking?.(event.message.thinking);
        }
        if (event.message?.content) {
          outcome.content += event.message.content;
          handlers.onContent?.(event.message.content);
        }
        if (event.message?.tool_calls) {
          outcome.toolCalls.push(...event.message.tool_calls);
        }
        if (event.done) {
          outcome.usage = {
            promptTokens: event.prompt_eval_count,
            outputTokens: event.eval_count,
            evalDurationNs: event.eval_duration,
            doneReason: event.done_reason,
          };
          succeed();
        }
      };

      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort);
      touch();

      request = this.open(
        "/api/chat",
        "POST",
        JSON.stringify({ ...payload, stream: true }),
        (response) => {
          touch();
          if ((response.statusCode ?? 500) >= 400) {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => fail(classifyServerError(response.statusCode ?? 500, Buffer.concat(chunks).toString("utf8"))));
            return;
          }

          response.on("data", (chunk: Buffer) => {
            touch();
            try {
              parser.push(chunk).forEach(handle);
            } catch {
              fail(new OllamaError("server", "Ollama sent a response that could not be read."));
            }
          });
          response.on("end", () => {
            try {
              parser.flush().forEach(handle);
            } catch {
              // The incomplete line is reported as an early end below.
            }
            fail(new OllamaError("server", "The Ollama response ended before it finished."));
          });
          response.on("error", (error) => fail(this.connectionError(error)));
        },
        (error) => fail(this.connectionError(error)),
      );
    });
  }
}
