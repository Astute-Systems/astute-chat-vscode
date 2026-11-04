import type { ChatUsage } from "./ollamaClient";

export type MeterPhase = "loading" | "processing" | "thinking" | "responding" | "tool" | "done";

export function formatTokens(count: number): string {
  if (count < 1000) {
    return String(Math.round(count));
  }
  return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) {
    return `${total}s`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * Tracks a response while it streams. Ollama reports token totals only in its
 * final event, so each chunk counts as one token until then. A finished round
 * replaces its estimate with the exact eval_count.
 */
export class TokenMeter {
  private phase: MeterPhase = "processing";
  private toolName = "";
  private readonly startedAt: number;
  private exactOutput = 0;
  private roundChunks = 0;
  private promptTokens = 0;
  private promptEstimate = 0;
  private roundStartedAt = 0;
  private evalNs = 0;
  private evalTokens = 0;

  constructor(
    private readonly contextLimit: number,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  beginRound(promptEstimate: number, modelLoaded: boolean): void {
    this.phase = modelLoaded ? "processing" : "loading";
    this.promptEstimate = promptEstimate;
    this.roundChunks = 0;
    this.roundStartedAt = 0;
  }

  chunk(kind: "thinking" | "responding"): void {
    if (!this.roundStartedAt) {
      this.roundStartedAt = this.now();
    }
    this.phase = kind;
    this.roundChunks += 1;
  }

  tool(name: string): void {
    this.phase = "tool";
    this.toolName = name;
  }

  endRound(usage: ChatUsage): void {
    this.exactOutput += usage.outputTokens ?? this.roundChunks;
    this.roundChunks = 0;
    this.promptTokens = usage.promptTokens ?? this.promptEstimate;
    if (usage.evalDurationNs && usage.outputTokens) {
      this.evalNs += usage.evalDurationNs;
      this.evalTokens += usage.outputTokens;
    }
  }

  get outputTokens(): number {
    return this.exactOutput + this.roundChunks;
  }

  private liveRate(): number {
    const elapsedMs = this.roundStartedAt ? this.now() - this.roundStartedAt : 0;
    return elapsedMs >= 500 ? (this.roundChunks / elapsedMs) * 1000 : 0;
  }

  private finalRate(): number {
    return this.evalNs ? (this.evalTokens / this.evalNs) * 1e9 : 0;
  }

  /** The live status line, for example "Thinking… · 2.7k tokens · 3.4 t/s". */
  status(): string {
    const elapsed = formatDuration(this.now() - this.startedAt);
    const tokens = this.outputTokens;
    switch (this.phase) {
      case "loading":
        return `Loading model… · ${elapsed}`;
      case "processing":
        return `Processing prompt… · ${elapsed}${tokens ? ` · ${formatTokens(tokens)} tokens` : ""}`;
      case "tool":
        return `Running ${this.toolName}… · ${formatTokens(tokens)} tokens`;
      case "thinking":
      case "responding": {
        const rate = this.liveRate();
        const label = this.phase === "thinking" ? "Thinking…" : "Responding…";
        return `${label} · ${formatTokens(tokens)} tokens${rate ? ` · ${rate.toFixed(1)} t/s` : ""}`;
      }
      default:
        return this.summary();
    }
  }

  /** The final line, for example "↑1.2k ↓3.2k · 3.4 t/s · 15m 40s · context 38%". */
  summary(): string {
    this.phase = "done";
    // Cached prompts report fewer tokens than they occupy, so use the larger figure.
    const contextUsed = Math.max(this.promptTokens, this.promptEstimate) + this.outputTokens;
    const parts = [`↑${formatTokens(this.promptTokens || this.promptEstimate)} ↓${formatTokens(this.outputTokens)}`];
    const rate = this.finalRate();
    if (rate) {
      parts.push(`${rate.toFixed(1)} t/s`);
    }
    parts.push(formatDuration(this.now() - this.startedAt));
    if (this.contextLimit) {
      parts.push(`context ${Math.min(100, Math.round((contextUsed / this.contextLimit) * 100))}%`);
    }
    return parts.join(" · ");
  }
}
