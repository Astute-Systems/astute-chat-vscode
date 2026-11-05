import { NEW_ERRORS } from "./toolDefinitions";
import { ChatMessage, ChatUsage, ModelInfo, OllamaClient, OllamaError, ToolCall, ToolDefinition } from "./ollamaClient";
import { TokenMeter } from "./tokenMeter";

const DEFAULT_TOOL_ROUNDS = 6;
const STATUS_INTERVAL_MS = 250;
const KEEP_TOOL_RESULTS = 2;
const MAX_FIX_ATTEMPTS = 3;
const MAX_FAILURE_CHARS = 2000;
/** More tool rounds for a task whose last command or edit failed, so it isn't cut off midway through a fix. */
const EXTRA_FIX_ROUNDS = 10;
const OUT_OF_ROUNDS = "You've run out of tool rounds and the last command or edit still failed, so the task isn't finished. You can't call any more tools. Don't say you'll do more. Say what you changed, what still fails, and quote the error.";
const FINISH_WHAT_YOU_SAID = "You said you'd do more, but you stopped without calling a tool. Do it now. If there's nothing left to do, say that the task is finished.";
/** Latest tool results are never removed, but they can shrink this far to leave room for the answer. */
const MIN_RESULT_TOKENS = 200;
const RESULT_SHORTENED = "\n[Shortened to fit the context window. Read a smaller range for more.]";
const TOOLS_WORK_PROMPT = "Your tools do work, so don't say they can't. Call list_files or search_text now, and read_file for the code. If a tool refuses something, read why and try a different tool.";
const EMPTY_REPLY_PROMPT = "You didn't write an answer. Answer the request now in plain text, using what you already have. If you don't have enough, say what's missing.";
/** Share of the context window the prompt may use. The rest is kept free for the reply. */
export const PROMPT_SHARE = 0.75;
/** Below this a prompt is too small to say anything about how a model counts tokens. */
const MIN_TOKENS_TO_MEASURE = 200;
const MAX_TOKEN_SCALE = 2;

/** Tool results starting with this are also shown to the user. */
export const REFUSED = "Refused: ";

const GUIDANCE_INTRO = "The user added this while you were working. Take it into account, change course if it asks you to, and carry on:\n";
const SKIPPED_FOR_GUIDANCE = "Skipped: the user sent new guidance before this ran. Read it, then decide whether this is still needed.";

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
  /** Share of the context window in use, whenever it changes. */
  onContext?(percent: number): void;
  /** The reply so far has been discarded, because a retry replaces it. */
  onContentReset?(): void;
}

export interface EngineRequest {
  client: OllamaClient;
  model: string;
  messages: ChatMessage[];
  contextLimit: number;
  /** How many real tokens this model uses for each estimated one. */
  tokenScale?: number;
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
  /** Checks a finished reply. What it returns is sent back once, and that retry replaces the reply. */
  checkReply?: (reply: string) => Promise<string | undefined>;
  /** Hands over guidance the user has sent since the last call. It's only ever text for the model, so it can't approve anything. */
  takeGuidance?: () => string[];
  signal?: AbortSignal;
  events: EngineEvents;
}

export interface EngineResult {
  content: string;
  thinking: string;
  summary: string;
  cancelled: boolean;
  /** Tokens Ollama counted for each estimated one, when a prompt was large enough to measure. */
  tokenRatio?: number;
  /** Whether any tool ran, which says more than what the reply claims. */
  usedTools?: boolean;
  /** The last command or edit was still failing when the reply ended. */
  unresolvedFailure?: boolean;
  /** The reply ended because tool rounds ran out, so the work may be unfinished. */
  hitToolLimit?: boolean;
}

export const CHARS_PER_TOKEN = 4;
const MESSAGE_TOKENS = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessages(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => {
    const toolCalls = message.tool_calls?.length ? estimateTokens(JSON.stringify(message.tool_calls)) : 0;
    return total + estimateTokens(message.content) + estimateTokens(message.thinking ?? "") + toolCalls + MESSAGE_TOKENS;
  }, 0);
}

/**
 * Moves towards what Ollama reports. A cached prompt reports fewer tokens than it
 * occupies, so a ratio of 1 or less says nothing and is ignored.
 */
export function nextTokenScale(current: number, ratio: number | undefined): number {
  return ratio && ratio > 1 ? Math.min(MAX_TOKEN_SCALE, (current + ratio) / 2) : current;
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
        const { content } = kept[index];
        const shortened = commandFailed(content) ? clipCommandResult(content, room * CHARS_PER_TOKEN) : content.slice(0, room * CHARS_PER_TOKEN);
        kept[index] = { ...kept[index], content: `${shortened}${RESULT_SHORTENED}` };
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

/** A reply that ends by saying what it will do next, instead of doing it. */
export function announcesMoreWork(reply: string): boolean {
  const last = reply.trim().split(/\n\s*\n/).at(-1) ?? "";
  return !last.endsWith("?") && /\b(i will now|i'll now|i am going to|i'm going to|let me now|now i will|now i'll|next,? i will|next,? i'll)\b/i.test(last);
}

/** Tools report failure in words, so only their success messages count as success. */
export function editFailed(result: string): boolean {
  return !/^(Edited|Created|Replaced) /.test(result) && !result.startsWith("The user denied");
}

/** Keeps the status at the start and most of the end, where builds and tests print their errors. */
export function clipCommandResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const start = Math.floor(maxChars / 4);
  return `${text.slice(0, start)}\n[Output shortened]\n${text.slice(start - maxChars)}`;
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

function guidanceMessages(guidance: string[]): ChatMessage[] {
  return guidance.map((text) => ({ role: "user", content: `${GUIDANCE_INTRO}${text}` }));
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
  let failedEdit = false;
  let pushedBack = false;
  let fixAttempts = 0;
  let toldToReport = false;
  let toldToFinish = false;
  let checked = false;
  let toolsOffered = true;
  let tokenRatio: number | undefined;
  const waitingGuidance: string[] = [];
  const fitLimit = Math.floor(request.contextLimit / (request.tokenScale ?? 1));

  let reportedContext: number | undefined;
  const report = (): void => {
    events.onStatus(meter.status());
    const percent = meter.contextPercent();
    if (percent !== undefined && percent !== reportedContext) {
      reportedContext = percent;
      events.onContext?.(percent);
    }
  };
  const ticker = setInterval(report, STATUS_INTERVAL_MS);
  // A checked reply is used as a whole, so a retry mustn't leave the failed draft in it.
  const startRetry = (): void => {
    if (request.checkReply) {
      content = "";
      events.onContentReset?.();
    } else if (content) {
      content += "\n\n";
      events.onContent("\n\n");
    }
  };
  events.onStatus(meter.status());

  try {
    for (let round = 0; ; round += 1) {
      // Guidance waits for the running tool, as stopping one midway could leave work half done.
      transcript.push(...guidanceMessages([...waitingGuidance.splice(0), ...(request.takeGuidance?.() ?? [])]));
      const toolRounds = (request.maxToolRounds ?? DEFAULT_TOOL_ROUNDS) + (request.fixFailures && failedOutput !== undefined ? EXTRA_FIX_ROUNDS : 0);
      // The model can't act any more, so it mustn't end by promising to.
      if (request.tools && request.fixFailures && failedOutput !== undefined && round >= toolRounds && !toldToReport) {
        toldToReport = true;
        transcript.push({ role: "user", content: `${OUT_OF_ROUNDS}\n\nIt printed:\n${failedOutput}` });
      }
      const toolTokens = request.tools ? estimateTokens(JSON.stringify(request.tools.definitions)) : 0;
      const fitted = fitToContext(transcript, fitLimit, request.messages.length - 1, toolTokens);
      if (fitted.dropped && round === 0) {
        events.onNotice(`Removed ${fitted.dropped} older message${fitted.dropped === 1 ? "" : "s"} to fit the context window.`);
      }

      const loaded = await client.isLoaded(model).catch(() => true);
      meter.beginRound(estimateMessages(fitted.messages) + toolTokens, loaded);
      report();

      const offerTools = request.tools && !askedForAnswer && round < toolRounds;
      toolsOffered = Boolean(offerTools);
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
      report();
      const estimated = estimateMessages(fitted.messages) + toolTokens;
      if (outcome.usage.promptTokens && estimated >= MIN_TOKENS_TO_MEASURE) {
        tokenRatio = Math.max(tokenRatio ?? 0, outcome.usage.promptTokens / estimated);
      }

      // Guidance that arrives as a reply ends is still answered, rather than left for the next request.
      if (outcome.toolCalls.length === 0) {
        const late = request.takeGuidance?.() ?? [];
        if (late.length) {
          transcript.push({ role: "assistant", content: outcome.content }, ...guidanceMessages(late));
          startRetry();
          continue;
        }
      }

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
      // A plan can end in one too, because Open questions is its last section.
      const askedQuestion = outcome.content.trim().endsWith("?") && !(request.checkReply && /^#{1,6}\s/m.test(outcome.content));
      if (outcome.toolCalls.length === 0 && request.tools && request.retryWithoutTools && !usedTools && !askedQuestion) {
        if (!retried) {
          retried = true;
          events.onNotice("The model replied without acting, so it was asked again.");
          transcript.push({ role: "assistant", content: outcome.content }, { role: "user", content: request.retryWithoutTools });
          startRetry();
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
        events.onNotice(`The last ${failedEdit ? "edit" : "command"} still failed when this reply ended. It printed: ${failedOutput}`);
      }

      if (outcome.toolCalls.length === 0 && request.checkReply && content.trim()) {
        const problem = await request.checkReply(content);
        if (problem && !checked) {
          checked = true;
          events.onNotice(`The reply needed fixing, so it was sent back: ${problem}`);
          transcript.push({ role: "assistant", content: outcome.content }, { role: "user", content: `Fix these problems, and write the whole thing again:\n${problem}` });
          startRetry();
          continue;
        }
        if (problem) {
          events.onNotice(`Check this before using it: ${problem}`);
        }
      }

      if (outcome.toolCalls.length === 0 && request.fixFailures && offerTools && usedTools && !toldToFinish && failedOutput === undefined && announcesMoreWork(outcome.content)) {
        toldToFinish = true;
        transcript.push({ role: "assistant", content: outcome.content }, { role: "user", content: FINISH_WHAT_YOU_SAID });
        startRetry();
        continue;
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
        waitingGuidance.push(...(request.takeGuidance?.() ?? []));
        // Calls chosen before the guidance may be what it's trying to prevent. Ollama needs a result for each one.
        if (waitingGuidance.length) {
          events.onNotice(`Skipped ${call.function.name}, because your guidance arrived first.`);
          transcript.push({ role: "tool", tool_name: call.function.name, content: SKIPPED_FOR_GUIDANCE });
          continue;
        }
        meter.tool(call.function.name);
        events.onStatus(meter.status());
        events.onTool(`${call.function.name}(${JSON.stringify(call.function.arguments ?? {})})`);
        const result = await request.tools.run(call, request.signal);
        if (result.startsWith(REFUSED)) {
          events.onNotice(result);
        }
        if (call.function.name === "run_command" || call.function.name === "run_tests") {
          const output = commandFailed(result) ? failureOutput(result) : undefined;
          // A different error means the fixes are getting somewhere, and tool rounds still limit them.
          if (output !== failedOutput) {
            fixAttempts = 0;
          }
          failedOutput = output;
          failedEdit = false;
        } else if (call.function.name === "write_file" || call.function.name === "edit_file") {
          const errors = result.indexOf(NEW_ERRORS);
          if (errors >= 0) {
            failedOutput = result.slice(errors);
            failedEdit = true;
          } else if (editFailed(result)) {
            // A failed build matters more than the edit meant to fix it, so it isn't replaced.
            if (failedOutput === undefined || failedEdit) {
              failedOutput = result;
              failedEdit = true;
            }
          } else if (failedEdit) {
            failedOutput = undefined;
            failedEdit = false;
          }
        }
        transcript.push({ role: "tool", tool_name: call.function.name, content: result });
      }
    }

    if (lastUsage.doneReason === "length") {
      events.onNotice("The reply was cut off by the context window. Increase astuteChat.numCtx to allow longer replies.");
    }
    return { content, thinking, summary: meter.summary(), cancelled: false, tokenRatio, usedTools, unresolvedFailure: failedOutput !== undefined, hitToolLimit: Boolean(request.tools) && !toolsOffered && !askedForAnswer };
  } catch (error) {
    if (error instanceof OllamaError && error.kind === "cancelled") {
      return { content, thinking, summary: `Stopped · ${meter.summary()}`, cancelled: true };
    }
    throw error;
  } finally {
    clearInterval(ticker);
  }
}
