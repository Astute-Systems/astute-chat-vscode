import * as vscode from "vscode";
import { getServerAddress } from "./config";
import { ModelInfo, OllamaClient } from "./ollamaClient";
import { isInsecureRemote, ServerAddress, toBaseUrl, toLabel } from "./server";

const CONNECTED_INTERVAL_MS = 30000;
const FIRST_RETRY_MS = 5000;
const MAX_RETRY_MS = 60000;

export interface ConnectionState {
  status: "checking" | "connected" | "offline";
  message: string;
  address: ServerAddress;
  server: string;
  insecureRemote: boolean;
  version?: string;
  models: ModelInfo[];
  abilities: Record<string, string[]>;
}

/** Watches the server and retries with backoff while it is unavailable. */
export class ConnectionMonitor implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ConnectionState>();
  readonly onDidChange = this.emitter.event;
  private timer: NodeJS.Timeout | undefined;
  private retryMs = FIRST_RETRY_MS;
  private generation = 0;
  private current: ConnectionState;
  private readonly abilities = new Map<string, string[]>();

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.current = this.describe("checking", "Checking the Ollama server…", []);
  }

  get state(): ConnectionState {
    return this.current;
  }

  private describe(status: ConnectionState["status"], message: string, models: ModelInfo[], version?: string): ConnectionState {
    const address = getServerAddress();
    return { status, message, address, server: toLabel(address), insecureRemote: isInsecureRemote(address), models, version, abilities: Object.fromEntries(this.abilities) };
  }

  private publish(state: ConnectionState): void {
    if (state.status !== this.current.status || state.server !== this.current.server) {
      this.log.info(`Connection ${state.status}: ${state.server}. ${state.message}`);
    }
    this.current = state;
    this.emitter.fire(state);
  }

  async refresh(): Promise<ConnectionState> {
    clearTimeout(this.timer);
    const generation = ++this.generation;
    const address = getServerAddress();
    const client = new OllamaClient(toBaseUrl(address));
    let next: ConnectionState;

    try {
      const [version, models] = await Promise.all([client.version(), client.listModels()]);
      await Promise.all(models.filter((model) => !this.abilities.has(model.name)).map(async (model) => {
        const details = await client.showModel(model.name).catch(() => undefined);
        if (details) {
          this.abilities.set(model.name, model.remote ? [...details.capabilities, "cloud"] : details.capabilities);
        }
      }));
      const count = `${models.length} model${models.length === 1 ? "" : "s"}`;
      next = this.describe("connected", `Connected to Ollama ${version} at ${toLabel(address)} with ${count}.`, models, version);
      this.retryMs = FIRST_RETRY_MS;
    } catch (error) {
      next = this.describe("offline", error instanceof Error ? error.message : "Could not connect to Ollama.", []);
    }

    if (generation !== this.generation) {
      return this.current;
    }
    this.publish(next);

    const delay = next.status === "connected" ? CONNECTED_INTERVAL_MS : this.retryMs;
    if (next.status === "offline") {
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    }
    this.timer = setTimeout(() => void this.refresh(), delay);
    return next;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.generation += 1;
    this.emitter.dispose();
  }
}
