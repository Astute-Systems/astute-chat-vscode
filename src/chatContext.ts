import * as fs from "fs/promises";
import * as path from "path";
import { capText } from "./chatSummary";
import type { ChangeReport } from "./messages";

const FILE_NAME = "context.txt";
const INTRO = ["# Chat context", "Astute Chat keeps this file up to date, and you can edit it. Text under Notes is never changed."];
const ACTIVITY_HEADING = "## Files and commands";
const NOTES_HEADING = "## Notes";
const MAX_ACTIVITY_LINES = 40;
const RECENT_ACTIVITY_LINES = 8;
const MAX_LINE_CHARS = 300;
const MAX_COMMAND_CHARS = 60;
const MAX_PLAN_TITLE_CHARS = 60;

export interface ChatContext {
  /** The model's summary. Hand edits to it are kept, and sent to the model. */
  summary: string;
  /** Facts from the extension, oldest first. */
  activity: string[];
  /** Belongs to the user, so the model can't change it. */
  notes: string;
}

export const EMPTY_CONTEXT: ChatContext = { summary: "", activity: [], notes: "" };

/** Everything after the Notes heading is notes, so nothing in them can be read as another section. */
export function parseContext(text: string): ChatContext {
  const summary: string[] = [];
  const activity: string[] = [];
  const lines = text.split("\n");
  let section: "summary" | "activity" = "summary";
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].trim();
    if (heading === NOTES_HEADING) {
      return { summary: summary.join("\n").trim(), activity, notes: lines.slice(index + 1).join("\n").trim() };
    }
    if (heading === ACTIVITY_HEADING) {
      section = "activity";
    } else if (section === "activity" && heading.startsWith("## ")) {
      section = "summary";
      summary.push(lines[index]);
    } else if (section === "activity") {
      if (heading) {
        activity.push(heading);
      }
    } else if (!INTRO.includes(lines[index])) {
      summary.push(lines[index]);
    }
  }
  return { summary: summary.join("\n").trim(), activity, notes: "" };
}

export function renderContext(context: ChatContext): string {
  return [...INTRO, "", context.summary, "", ACTIVITY_HEADING, ...context.activity, "", NOTES_HEADING, context.notes, ""].join("\n");
}

/** Model output passes through the parser too, so it can't write the sections it doesn't own. */
export function cleanSummary(text: string, maxTokens: number): string {
  return capText(parseContext(text).summary, maxTokens);
}

function oneLine(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

/** Tool calls are recorded as name(json), and saved or long ones may have lost their arguments. */
function toolArguments(call: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.slice(call.indexOf("(") + 1, -1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One line of fact about a reply, taken from what the tools did and not from what the model said. */
export function activityLine(changes: ChangeReport | undefined, tools: readonly string[]): string | undefined {
  const named = (name: string, key: string): string[] => [...new Set(tools.filter((call) => call.startsWith(`${name}(`)).map((call) => toolArguments(call)[key]).filter((value): value is string => typeof value === "string" && !!value))];
  const parts: string[] = [];
  if (changes?.created.length) {
    parts.push(`created ${changes.created.join(", ")}`);
  }
  if (changes?.edited.length) {
    parts.push(`edited ${changes.edited.join(", ")}`);
  }
  const read = named("read_file", "path");
  if (read.length) {
    parts.push(`read ${read.join(", ")}`);
  }
  if (changes?.commands) {
    const list = named("run_command", "command").map((command) => oneLine(command, MAX_COMMAND_CHARS));
    parts.push(`ran ${changes.commands} command${changes.commands === 1 ? "" : "s"}${changes.failedCommands ? ` (${changes.failedCommands} failed)` : ""}${list.length ? `: ${list.join("; ")}` : ""}`);
  }
  return parts.length ? `- ${oneLine(parts.join("; "), MAX_LINE_CHARS)}` : undefined;
}

/** A short name for a plan: its goal, or failing that its first line of text. */
export function planTitle(plan: string): string {
  const lines = plan.split("\n").map((line) => line.trim());
  const goal = lines.findIndex((line) => /^#+\s*goal\b/i.test(line));
  const first = lines.slice(goal + 1).find((line) => line && !line.startsWith("#")) ?? lines.find(Boolean) ?? "Plan";
  return oneLine(first.replace(/^[-*\d.\s#]+/, ""), MAX_PLAN_TITLE_CHARS) || "Plan";
}

export function recentActivity(context: ChatContext): string[] {
  return context.activity.slice(-RECENT_ACTIVITY_LINES);
}

/**
 * Keeps one context file per chat in the extension's storage. It stays out of the
 * workspace because Ask and Plan must change nothing there, it could be committed
 * with chat text in it, and a file from a cloned repository would reach the prompt.
 */
export class ChatContextStore {
  constructor(private readonly root: string) {}

  file(chatId: string): string {
    return path.join(this.root, "chats", chatId, FILE_NAME);
  }

  /** Each plan keeps its own file, so choosing an older one can't pick up a newer one. */
  planFile(chatId: string, planId: string): string {
    return path.join(path.dirname(this.file(chatId)), `plan-${planId}.md`);
  }

  private async write(file: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, text);
    await fs.rename(temporary, file);
  }

  writePlan(chatId: string, planId: string, plan: string): Promise<void> {
    return this.write(this.planFile(chatId, planId), plan);
  }

  /** Undefined if the file doesn't exist. Read each time, so hand edits count. */
  readPlan(chatId: string, planId: string): Promise<string | undefined> {
    return fs.readFile(this.planFile(chatId, planId), "utf8").catch(() => undefined);
  }

  /** Undefined if the file doesn't exist. */
  async read(chatId: string): Promise<ChatContext | undefined> {
    const text = await fs.readFile(this.file(chatId), "utf8").catch(() => undefined);
    return text === undefined ? undefined : parseContext(text);
  }

  /** Reads the file at the last moment, so edits made during a slow summary survive. */
  async update(chatId: string, change: (context: ChatContext) => ChatContext): Promise<ChatContext> {
    const context = change((await this.read(chatId)) ?? EMPTY_CONTEXT);
    await this.write(this.file(chatId), renderContext(context));
    return context;
  }

  addActivity(chatId: string, line: string): Promise<ChatContext> {
    return this.update(chatId, (context) => ({ ...context, activity: [...context.activity, oneLine(line, MAX_LINE_CHARS)].slice(-MAX_ACTIVITY_LINES) }));
  }

  async remove(chatId: string): Promise<void> {
    await fs.rm(path.dirname(this.file(chatId)), { recursive: true, force: true });
  }
}
