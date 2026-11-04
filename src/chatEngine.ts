import { ChatMessage, ChatUsage, ModelInfo, OllamaClient, OllamaError, ToolCall, ToolDefinition } from "./ollamaClient";
import { TokenMeter } from "./tokenMeter";

const DEFAULT_TOOL_ROUNDS = 6;
const STATUS_INTERVAL_MS = 250;
const KEEP_TOOL_RESULTS = 2;
const MAX_FIX_ATTEMPTS = 3;
const MAX_FAILURE_CHARS = 600;
/** Latest tool results are never removed, but they can shrink this far to leave room for the answer. */
const MIN_RESULT_TOKENS = 200;
const RESULT_SHORTENED = "\n[Shortened to fit the context window. Read a smaller range for more.]";
const TOOLS_WORK_PROMPT = "Your tools do work, so don't say they can't. Call list_files or search_text now, and read_file for the code. If a tool refuses something, read why and try a different tool.";
const EMPTY_REPLY_PROMPT = "You didn't write an answer. Answer the request now in plain text, using what you already have. If you don't have enough, say what's missing.";
/** Share of the context window kept free for the reply. */
const PROMPT_SHARE = 0.75;

/** Tool results starting with this are also shown to the user. */
export const REFUSED = "Refused: ";

export interface ToolRunner {
  definitions: ToolDefinition[];
  run(call: ToolCall, signal?: AbortSignal): Promise<string>;
}

export interface EngineEvents {
  onStatus(text: string): void;
  onThinking(text: string): void;
  onContent(text: string): void;
  onTool(description: string): void;
  onNotice(text: string): void;
}

export interface EngineRequest {
  client: OllamaClient;
  model: string;
  messages: ChatMessage[];
  contextLimit: number;
  numThread?: number;
  temperature: number;
  keepAlive: string;
  idleTimeoutMs: number;
  think: boolean;
  tools?: ToolRunner;
  maxToolRounds?: number;
  /** When set, a reply with no tool calls is retried once with this message. */
  retryWithoutTools?: string;
  /** When set, a reply that ends on a failed command is sent back to fix it. */
  fixFailures?: string;
  signal?: AbortSignal;
  events: EngineEvents;
}

export interface EngineResult {
  content: string;
  thinking: string;
  summary: string;
  cancelled: boolean;
}

const CHARS_PER_TOKEN = 4;
const MESSAGE_TOKENS = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessages(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content) + MESSAGE_TOKENS, 0);
}

const SHORTENED_OUTPUT = "[Output removed to save space. Run the tool again if you need it.]";

/**
 * Makes a prompt fit while keeping the system prompt, the user's request and the
 * latest tool results. It shortens old tool output first, then removes older
 * chat turns, then removes the oldest tool calls with their results, because
 * Ollama needs a tool result to stay with its call.
 */
export function fitToContext(messages: ChatMessage[], limit: number, requestIndex = messages.map((message) => message.role).lastIndexOf("user"), reservedTokens = 0): { messages: ChatMessage[]; dropped: number } {
  const budget = Math.floor(limit * PROMPT_SHARE) - reservedTokens;
  const kept = [...messages];
  const fits = (): boolean => estimateMessages(kept) <= budget;
  let request = requestIndex;
  let dropped = 0;

  const toolResults = kept.flatMap((message, index) => (message.role === "tool" && index > request ? [index] : []));
  for (const index of toolResults.slice(0, -KEEP_TOOL_RESULTS)) {
    if (fits()) {
      break;
    }
    kept[index] = { ...kept[index], content: SHORTENED_OUTPUT };
  }

  while (!fits() && request > 0) {
    const oldest = kept.findIndex((message) => message.role !== "system");
    if (oldest < 0 || oldest >= request) {
      break;
    }
    // A reply is removed with its question, so no stray answers are left behind.
    const count = kept[oldest].role === "user" && kept[oldest + 1]?.role === "assistant" && oldest + 1 < request ? 2 : 1;
    kept.splice(oldest, count);
    request -= count;
    dropped += count;
  }

  while (!fits()) {
    const starts = kept.flatMap((message, index) => (message.tool_calls?.length && index > request ? [index] : []));
    if (starts.length < 2) {
      break;
    }
    let end = starts[0] + 1;
    while (kept[end]?.role === "tool") {
      end += 1;
    }
    dropped += end - starts[0];
    kept.splice(starts[0], end - starts[0]);
  }

  // Without this, two large file reads filled the window and left no room to answer.
  if (!fits()) {
    const results = kept.flatMap((message, index) => (message.role === "tool" && index > request ? [index] : []));
    const others = estimateMessages(kept.filter((_, index) => !results.includes(index)));
    // Each result also pays for its message and the note added below.
    const overhead = MESSAGE_TOKENS + estimateTokens(RESULT_SHORTENED);
    const room = Math.max(MIN_RESULT_TOKENS, Math.floor((budget - others) / Math.max(results.length, 1)) - overhead);
    for (const index of results) {
      if (estimateTokens(kept[index].content) > room) {
        kept[index] = { ...kept[index], content: `${kept[index].content.slice(0, room * CHARS_PER_TOKEN)}${RESULT_SHORTENED}` };
      }
    }
  }
  return { messages: kept, dropped };
}

/**
 * Automatic choices must stay on this server, because a cloud model sends code away.
 * Cloud models also look smallest, at a few hundred bytes, so size alone would pick one.
 */
export function localModels<T extends { remote?: boolean }>(models: readonly T[]): T[] {
  return models.filter((model) => !model.remote);
}

/** Prefers models that support thinking too, which call tools more reliably, then the smallest. */
export function chooseToolModel(models: ReadonlyArray<{ name: string; size: number; remote?: boolean; capabilities: string[] }>): string | undefined {
  return localModels(models)
    .filter((model) => model.capabilities.includes("tools"))
    .sort((a, b) => Number(b.capabilities.includes("thinking")) - Number(a.capabilities.includes("thinking")) || a.size - b.size)[0]?.name;
}

/** Models say their tools are broken instead of trying them, or after one refused command. */
export function claimsToolsBroken(reply: string): boolean {
  return /\b(unable|can't|cannot|can not|not able|couldn't|don't have (the )?(ability|access))\b[^.\n]{0,40}\b(tools?|list|search|access|read|run|execute|perform|browse)\b/i.test(reply)
    || /\btools?\b[^.\n]{0,40}\b(unable|can't|cannot|not able|don't work|aren't working|not working|unavailable)\b/i.test(reply);
}

/** The status comes first in a command result, so program output can't be mistaken for it. */
export function commandFailed(result: string): boolean {
  const status = result
    .split("\n")
    .slice(0, 2)
    .find((line) => /^(Exit code |Timed out)/.test(line));
  return status !== undefined && status !== "Exit code 0";
}

/** The end of a failed command's output, where the error is. It comes from the command, so a model can't reword it. */
function failureOutput(result: string): string {
  const output = result.split("\n").slice(1).join("\n").trim();
  return output.length > MAX_FAILURE_CHARS ? `…${output.slice(-MAX_FAILURE_CHARS)}` : output;
}

/** Picks a model: the exact name, a unique tagless match, or the smallest local one. */
export function resolveModel(configured: string, installed: ModelInfo[]): { name?: string; reason?: "default" | "missing" } {
  const wanted = configured.trim();
  if (!wanted) {
    const smallest = localModels(installed).sort((a, b) => a.size - b.size)[0];
    return { name: smallest?.name, reason: smallest ? "default" : "missing" };
  }
  if (installed.some((model) => model.name === wanted)) {
    return { name: wanted };
  }
  const tagged = installed.filter((model) => model.name.startsWith(`${wanted}:`));
  return tagged.length === 1 ? { name: tagged[0].name } : { reason: "missing" };
}

export async function runChat(request: EngineRequest): Promise<EngineResult> {
  const { client, events, model } = request;
  const meter = new TokenMeter(request.contextLimit);
  const transcript = [...request.messages];
  let content = "";
  let thinking = "";
  let lastUsage: ChatUsage = {};
  let usedTools = false;
  let retried = false;
  let failedOutput: string | undefined;
  let askedForAnswer = false;
  let pushedBack = false;
  let fixAttempts = 0;

  const ticker = setInterval(() => events.onStatus(meter.status()), STATUS_INTERVAL_MS);
  events.onStatus(meter.status());

  try {
    for (let round = 0; ; round += 1) {
      const toolTokens = request.tools ? estimateTokens(JSON.stringify(request.tools.definitions)) : 0;
      const fitted = fitToContext(transcript, request.contextLimit, request.messages.length - 1, toolTokens);
      if (fitted.dropped && round === 0) {
        events.onNotice(`Removed ${fitted.dropped} older message${fitted.dropped === 1 ? "" : "s"} to fit the context window.`);
      }

      const loaded = await client.isLoaded(model).catch(() => true);
      meter.beginRound(estimateMessages(fitted.messages), loaded);
      events.onStatus(meter.status());

      const offerTools = request.tools && !askedForAnswer && round < (request.maxToolRounds ?? DEFAULT_TOOL_ROUNDS);
      const outcome = await client.chat(
        {
          model,
          messages: fitted.messages,
          tools: offerTools ? request.tools?.definitions : undefined,
          think: request.think && !askedForAnswer ? true : undefined,
          keep_alive: request.keepAlive,
          options: { temperature: request.temperature, num_ctx: request.contextLimit, num_thread: request.numThread },
        },
        {
          onThinking: (text) => {
            meter.chunk("thinking");
            thinking += text;
            events.onThinking(text);
          },
          onContent: (text) => {
            meter.chunk("responding");
            content += text;
            events.onContent(text);
          },
        },
        { signal: request.signal, idleTimeoutMs: request.idleTimeoutMs },
      );

      meter.endRound(outcome.usage);
      lastUsage = outcome.usage;

      // A failed command comes first, because its real error is more use than this.
      if (outcome.toolCalls.length === 0 && offerTools && !pushedBack && failedOutput === undefined && claimsToolsBroken(outcome.content)) {
        pushedBack = true;
        events.onNotice("The model said its tools weren't working, so it was told to try them.");
        transcript.push({ role: "assistant", content: outcome.content }, { role: "user", content: TOOLS_WORK_PROMPT });
        if (content) {
          content += "\n\n";
          events.onContent("\n\n");
        }
        continue;
      }

      // A question is a fair reply when a request is unclear, so it isn't retried.
      const askedQuestion = outcome.content.trim().endsWith("?");
      if (outcome.toolCalls.length === 0 && request.tools && request.retryWithoutTools && !usedTools && !askedQuestion) {
        if (!retried) {
          retried = true;
          events.onNotice("The model replied without acting, so it was asked again.");
          transcript.push({ role: "assistant", content: outcome.content }, { role: "user", content: request.retryWithoutTools });
          if (content) {
            content += "\n\n";
            events.onContent("\n\n");
          }
          continue;
        }
        events.onNotice(`${model} didn't use any tools, so nothing in the workspace changed. Try again, or choose another model.`);
      }

      // Asking a question doesn't excuse a failure: models also use one to hide it.
      if (outcome.toolCalls.length === 0 && request.fixFailures && failedOutput !== undefined) {
        if (fixAttempts < MAX_FIX_ATTEMPTS && offerTools) {
          fixAttempts += 1;
          transcript.push({ role: "assistant", content: outcome.content }, { role: "user", content: `${request.fixFailures}\n\nIt printed:\n${failedOutput}` });
          if (content) {
            content += "\n\n";
            events.onContent("\n\n");
          }
          continue;
        }
        events.onNotice(`The last command still failed when this reply ended. It printed: ${failedOutput}`);
      }

      // Thinking can use up the whole reply, which leaves the user with a blank answer.
      if (outcome.toolCalls.length === 0 && !content.trim()) {
        if (!askedForAnswer) {
          askedForAnswer = true;
          transcript.push({ role: "user", content: EMPTY_REPLY_PROMPT });
          continue;
        }
        events.onNotice(`${model} didn't write an answer. Try again, or increase astuteChat.numCtx.`);
      }

      if (outcome.toolCalls.length === 0 || !request.tools) {
        break;
      }

      usedTools = true;
      transcript.push({ role: "assistant", content: outcome.content, thinking: outcome.thinking || undefined, tool_calls: outcome.toolCalls });
      for (const call of outcome.toolCalls) {
        if (request.signal?.aborted) {
          throw new OllamaError("cancelled", "Stopped.");
        }
        meter.tool(call.function.name);
        events.onStatus(meter.status());
        events.onTool(`${call.function.name}(${JSON.stringify(call.function.arguments ?? {})})`);
        const result = await request.tools.run(call, request.signal);
        if (result.startsWith(REFUSED)) {
          events.onNotice(result);
        }
        if (call.function.name === "run_command") {
          failedOutput = commandFailed(result) ? failureOutput(result) : undefined;
        }
        transcript.push({ role: "tool", tool_name: call.function.name, content: result });
      }
    }

    if (lastUsage.doneReason === "length") {
      events.onNotice("The reply was cut off by the context window. Increase astuteChat.numCtx to allow longer replies.");
    }
    return { content, thinking, summary: meter.summary(), cancelled: false };
  } catch (error) {
    if (error instanceof OllamaError && error.kind === "cancelled") {
      return { content, thinking, summary: `Stopped · ${meter.summary()}`, cancelled: true };
    }
    throw error;
  } finally {
    clearInterval(ticker);
  }
}
