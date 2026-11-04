import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ChangeJournal } from "../changeJournal";
import type { HistoryBudget, PreparedHistory } from "../chatService";
import { commitReview, currentBranch, startReview } from "../reviewBranch";
import type { TranscriptEntry } from "../messages";
import { chatRows, chatTitle } from "../savedChats";

// chatView.ts needs the vscode module, which only exists inside VS Code.
const Module = require("node:module") as { _load(request: string, ...rest: unknown[]): unknown };
const load = Module._load;
class EventEmitter {
  private listeners: Array<() => void> = [];
  event = (listener: () => void): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(): void {
    this.listeners.forEach((listener) => listener());
  }
  dispose(): void {
    this.listeners = [];
  }
}
const opened: string[] = [];
const shownErrors: string[] = [];
let failToOpen = false;
const shownWarnings: string[] = [];
let warningChoice: string | undefined;
const vscodeStub = {
  EventEmitter,
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  ProgressLocation: { Notification: 15 },
  commands: { executeCommand: async () => undefined },
  window: {
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: () => ({ dispose: () => undefined }),
    showInformationMessage: async () => undefined,
    showErrorMessage: async (text: string) => void shownErrors.push(text),
    showWarningMessage: async (_text: string, options: { detail: string }) => {
      shownWarnings.push(options.detail);
      return warningChoice;
    },
    showTextDocument: async (uri: { fsPath: string }) => {
      if (failToOpen) {
        throw new Error("no editor");
      }
      opened.push(uri.fsPath);
    },
    withProgress: (_options: unknown, task: (progress: unknown, token: unknown) => unknown) => Promise.resolve(task({}, { onCancellationRequested: () => undefined })),
  },
  workspace: {
    workspaceFolders: undefined,
    isTrusted: true,
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
  },
};
Module._load = function (request: string, ...rest: unknown[]) {
  return request === "vscode" ? vscodeStub : load.call(this, request, ...rest);
};
const { ChatViewProvider } = require("../chatView") as typeof import("../chatView");
Module._load = load;

interface FakeTurn {
  signal: AbortSignal;
  events: { onContent(text: string): void };
}

function makeProvider(service: unknown) {
  const store = new Map<string, unknown>();
  const workspaceState = {
    get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
    update: async (key: string, value: unknown) => void store.set(key, value),
  };
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "astute-chat-"));
  const context = { workspaceState, subscriptions: [], storageUri: { fsPath: storage } };
  const monitor = { onDidChange: () => ({ dispose: () => undefined }) };
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const provider = new ChatViewProvider(context as never, service as never, monitor as never, log as never);
  provider.postState = () => undefined;
  const saved = () => store.get("astuteChat.chats") as Array<{ title: string; transcript: TranscriptEntry[] }>;
  return { provider, saved, store, storage };
}

/** Streams some text, then waits to be stopped, like a slow model. */
const stoppableService = (began: () => void) => ({
  commandSkills: () => [],
  runTurn: ({ signal, events }: FakeTurn) => {
    events.onContent("partial answer");
    began();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Stopped."))));
  },
});

test("names a chat after its first request", () => {
  const transcript: TranscriptEntry[] = [
    { role: "info", content: "Loaded 1 skill." },
    { role: "user", content: "  fix\n the   build " },
  ];
  assert.equal(chatTitle(transcript), "fix the build");
  assert.equal(chatTitle(transcript.slice(0, 1)), undefined);
});

test("lists the current chat first, so an opened chat doesn't vanish", () => {
  const saved = [{ id: 4, title: "older", updatedAt: 1 }];
  assert.deepEqual(
    chatRows("now", saved).map((row) => [row.title, row.current]),
    [
      ["now", true],
      ["older", false],
    ],
  );
  assert.equal(chatRows(undefined, saved).length, 1);
});

test("New Chat during a reply saves what the reply had so far", async () => {
  let began = (): void => undefined;
  const started = new Promise<void>((resolve) => (began = resolve));
  const { provider, saved } = makeProvider(stoppableService(began));
  const turn = provider.send("hello");
  await started;
  await provider.clear();
  await turn;
  assert.equal(saved().length, 1);
  const [user, reply] = saved()[0].transcript;
  assert.equal(user.content, "hello");
  assert.match(reply.content, /partial answer/);
  assert.equal(provider.chatRows.filter((row) => row.current).length, 0, "the new chat is empty");
});

test("pressing New Chat twice during a reply saves the chat once", async () => {
  let began = (): void => undefined;
  const started = new Promise<void>((resolve) => (began = resolve));
  const { provider, saved } = makeProvider(stoppableService(began));
  const turn = provider.send("hello");
  await started;
  await Promise.all([provider.clear(), provider.clear()]);
  await turn;
  assert.equal(saved().length, 1);
});

test("reports when a saved chat can't open yet, because a reply is running", async () => {
  let began = (): void => undefined;
  let started = new Promise<void>((resolve) => (began = resolve));
  const { provider } = makeProvider(stoppableService(() => began()));
  const first = provider.send("first");
  await started;
  await provider.clear();
  await first;
  const [saved] = provider.chatList;
  started = new Promise<void>((resolve) => (began = resolve));
  const second = provider.send("second");
  await started;
  assert.equal(await provider.openSavedChat(saved.id), false);
  await provider.clear();
  await second;
  assert.equal(await provider.openSavedChat(saved.id), true);
});

interface ContextTurn {
  prepareHistory(budget: HistoryBudget): Promise<PreparedHistory>;
  events: { onContent(text: string): void; onTool(text: string): void };
}

const WINDOW = { model: "m", contextLimit: 8192, usableLimit: 8192 };
const LONG = "x".repeat(3000);

/** Answers each turn at once and keeps what it was asked to send. */
function contextService(options: { reply?: string; tools?: string[]; summary?: string } = {}) {
  const turns: PreparedHistory[] = [];
  const summarised: Array<{ count: number; earlier?: string; model: string }> = [];
  return {
    turns,
    summarised,
    service: {
      commandSkills: () => [],
      summaryTarget: async () => WINDOW,
      summarise: async (messages: unknown[], earlier: string | undefined, target: { model: string }) => {
        summarised.push({ count: messages.length, earlier, model: target.model });
        return options.summary === "" ? undefined : (options.summary ?? "## Goal\n- ship it");
      },
      runTurn: async ({ prepareHistory, events }: ContextTurn) => {
        turns.push(await prepareHistory({ ...WINDOW, reservedTokens: 1000 }));
        options.tools?.forEach((tool) => events.onTool(tool));
        events.onContent(options.reply ?? LONG);
        return { model: "m", summary: "done", imageText: "", cancelled: false };
      },
    },
  };
}

function contextFile(storage: string): string {
  const folder = path.join(storage, "chats");
  const [chat] = fs.readdirSync(folder);
  return path.join(folder, chat, "context.txt");
}

async function chatLongEnoughToSummarise(provider: { send(text: string): Promise<void> }): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await provider.send(`request ${index} ${LONG}${LONG}`);
  }
}

test("a long chat is summarised into context.txt and leaves the history", async () => {
  const { service, turns, summarised } = contextService();
  const { provider, storage } = makeProvider(service);
  await chatLongEnoughToSummarise(provider);
  assert.ok(summarised.length > 0);
  assert.equal(summarised[0].model, "m");
  assert.match(fs.readFileSync(contextFile(storage), "utf8"), /## Goal\n- ship it/);
  const last = turns.at(-1);
  assert.match(last?.systemSection ?? "", /<chat-notes>\n## Goal\n- ship it\n<\/chat-notes>/);
  assert.ok((last?.history.length ?? 0) < 6, "summarised messages aren't sent again");
});

test("the file is read each turn, so hand edits reach the model", async () => {
  const { service, turns } = contextService({ reply: "short" });
  const { provider, storage } = makeProvider(service);
  await chatLongEnoughToSummarise(provider);
  fs.writeFileSync(contextFile(storage), fs.readFileSync(contextFile(storage), "utf8").replace("- ship it", "- ship it on Friday").replace("## Notes\n", "## Notes\nUse tabs.\n"));
  await provider.send("next");
  assert.match(turns.at(-1)?.systemSection ?? "", /ship it on Friday/);
  assert.match(turns.at(-1)?.systemSection ?? "", /user wrote these notes[^\n]*\nUse tabs\./);
});

test("deleting the file brings the summarised messages back", async () => {
  const { service, summarised } = contextService({ reply: "short" });
  const { provider, storage } = makeProvider(service);
  await chatLongEnoughToSummarise(provider);
  const before = summarised.at(-1)?.count ?? 0;
  fs.rmSync(contextFile(storage));
  await provider.send("next");
  assert.equal(summarised.at(-1)?.earlier, undefined, "nothing is left of the old summary");
  assert.ok((summarised.at(-1)?.count ?? 0) > before, "the older messages are summarised again");
});

test("a failed summary keeps every message", async () => {
  const { service, turns, summarised } = contextService({ summary: "" });
  const { provider, store } = makeProvider(service);
  await chatLongEnoughToSummarise(provider);
  assert.ok(summarised.length > 0);
  assert.equal(store.get("astuteChat.summary"), undefined);
  assert.equal(turns.at(-1)?.history.length, 6);
});

test("moves a summary saved by an older version into the file", async () => {
  const { service, turns } = contextService({ reply: "short" });
  const { provider, storage, store } = makeProvider(service);
  await provider.send("first");
  (provider as unknown as { summary: unknown }).summary = { text: "- from before", upTo: 2 };
  await provider.send("second");
  assert.match(fs.readFileSync(contextFile(storage), "utf8"), /- from before/);
  assert.match(turns.at(-1)?.systemSection ?? "", /- from before/);
  assert.deepEqual(store.get("astuteChat.summary"), { upTo: 2 });
});

test("records tool work outside the system prompt, which stays the same between turns", async () => {
  const tools = ['read_file({"path":"src/a.ts"})'];
  const { service, turns } = contextService({ reply: "short", tools });
  const { provider, storage, store } = makeProvider(service);
  await provider.send("first");
  await provider.send("second");
  assert.match(fs.readFileSync(contextFile(storage), "utf8"), /- read src\/a\.ts/);
  assert.match(turns[1].requestNote ?? "", /isn't part of the request:\n- read src\/a\.ts/);
  assert.equal(turns[0].systemSection, turns[1].systemSection);
  assert.doesNotMatch(JSON.stringify(store.get("astuteChat.transcript")), /isn't part of the request/, "the note isn't stored in the chat");
});

test("a reply that used no tools creates no file", async () => {
  const { service } = contextService({ reply: "short" });
  const { provider, storage } = makeProvider(service);
  await provider.send("hello");
  assert.equal(fs.existsSync(path.join(storage, "chats")), false);
});

test("each chat keeps its own context, which goes when the chat is deleted", async () => {
  const { service, turns } = contextService({ reply: "short", tools: ['read_file({"path":"one.ts"})'] });
  const { provider, storage } = makeProvider(service);
  await provider.send("first chat");
  await provider.clear();
  const [saved] = provider.chatList;
  await provider.send("second chat");
  assert.equal(turns.at(-1)?.requestNote, "", "a new chat starts with nothing");
  assert.equal(fs.readdirSync(path.join(storage, "chats")).length, 2);
  await provider.clear();
  const next = provider.chatList.find((chat) => chat.id !== saved.id);
  await provider.openSavedChat(saved.id);
  await provider.send("back again");
  assert.match(turns.at(-1)?.requestNote ?? "", /one\.ts/);
  await provider.deleteChat(next?.id ?? 0);
  assert.equal(fs.readdirSync(path.join(storage, "chats")).length, 1);
});

test("Update Chat Context summarises now, keeping the latest messages", async () => {
  const { service, turns, summarised } = contextService({ reply: "short" });
  const { provider, storage } = makeProvider(service);
  for (let index = 0; index < 4; index += 1) {
    await provider.send(`request ${index}`);
  }
  await provider.updateContext();
  assert.equal(summarised[0].count, 4);
  assert.match(fs.readFileSync(contextFile(storage), "utf8"), /ship it/);
  await provider.send("next");
  assert.equal(turns.at(-1)?.history.length, 4);
});

test("Update Chat Context works on a short chat without dropping it", async () => {
  const { service, turns } = contextService({ reply: "short" });
  const { provider } = makeProvider(service);
  await provider.send("only request");
  await provider.updateContext();
  await provider.send("next");
  assert.equal(turns.at(-1)?.history.length, 2);
  assert.match(turns.at(-1)?.systemSection ?? "", /ship it/);
});

test("a reply can't start while the context is updating", async () => {
  let finish = (_text: string): void => undefined;
  const { service, turns } = contextService({ reply: "short" });
  const { provider } = makeProvider({ ...service, summarise: () => new Promise((resolve) => (finish = resolve)) });
  await provider.send("first");
  const update = provider.updateContext();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await provider.send("too soon");
  assert.equal(turns.length, 1);
  finish("- done");
  await update;
  await provider.send("now");
  assert.equal(turns.length, 2);
});

test("opens the chat's context file, creating it for a chat with no messages", async () => {
  const { service } = contextService();
  const { provider, storage, store } = makeProvider(service);
  await provider.openContext();
  assert.equal(opened.at(-1), contextFile(storage));
  assert.match(fs.readFileSync(contextFile(storage), "utf8"), /## Notes/);
  assert.ok(store.get("astuteChat.chatId"), "the id survives a reload, so the file is found again");
});

test("notes written before the first message reach it", async () => {
  const { service, turns } = contextService({ reply: "short" });
  const { provider, storage } = makeProvider(service);
  await provider.openContext();
  fs.appendFileSync(contextFile(storage), "Use tabs.\n");
  await provider.send("first");
  assert.match(turns[0].systemSection ?? "", /Use tabs\./);
});

test("New Chat on an empty chat keeps its notes", async () => {
  const { service, turns } = contextService({ reply: "short" });
  const { provider, storage } = makeProvider(service);
  await provider.openContext();
  fs.appendFileSync(contextFile(storage), "Use tabs.\n");
  await provider.clear();
  await provider.send("first");
  assert.match(turns[0].systemSection ?? "", /Use tabs\./);
});

test("opening the file doesn't lose a summary saved by an older version", async () => {
  const { service } = contextService();
  const { provider, storage } = makeProvider(service);
  (provider as unknown as { summary: unknown }).summary = { text: "- from before", upTo: 0 };
  await provider.openContext();
  assert.match(fs.readFileSync(contextFile(storage), "utf8"), /- from before/);
});

test("says so if the file can't be opened", async () => {
  const { service } = contextService();
  const { provider } = makeProvider(service);
  failToOpen = true;
  await provider.openContext().finally(() => (failToOpen = false));
  assert.match(shownErrors.at(-1) ?? "", /Could not open/);
});

test("shows context use during a reply and clears it for a new chat", async () => {
  const { provider } = makeProvider({
    commandSkills: () => [],
    runTurn: async ({ events }: { events: { onContext(percent: number): void } }) => {
      events.onContext(38);
      return { model: "m", summary: "done", imageText: "", cancelled: false };
    },
  });
  const posted: unknown[] = [];
  (provider as unknown as { post(message: unknown): void }).post = (message) => posted.push(message);
  const contextUse = () => (provider as unknown as { contextUse?: number }).contextUse;
  await provider.send("hello");
  assert.deepEqual(posted.find((message) => (message as { type: string }).type === "contextUse"), { type: "contextUse", percent: 38 });
  assert.equal(contextUse(), 38);
  await provider.clear();
  assert.equal(contextUse(), undefined);
});

test("the context file records undoing a reply, so the record of its changes isn't left standing", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "astute-undo-")), "new.ts");
  const { service, turns } = contextService({ reply: "short" });
  const runTurn = service.runTurn;
  const { provider, storage, store } = makeProvider({
    ...service,
    runTurn: async (request: ContextTurn & { journal: ChangeJournal }) => {
      fs.writeFileSync(file, "made by the reply");
      request.journal.recordFile(file, "new.ts", null, "made by the reply");
      return runTurn(request);
    },
  });
  await provider.receive({ type: "selectMode", mode: "agent" });
  await provider.send("make a file");
  assert.match(fs.readFileSync(contextFile(storage), "utf8"), /- created new\.ts/);
  const reply = (store.get("astuteChat.transcript") as TranscriptEntry[]).find((entry) => entry.undoId !== undefined);
  await provider.receive({ type: "undoTurn", id: reply?.undoId ?? 0 });
  assert.equal(fs.existsSync(file), false);
  assert.match(fs.readFileSync(contextFile(storage), "utf8"), /- created new\.ts\n- Undid changes to new\.ts\./);
  await provider.send("next");
  assert.match(turns.at(-1)?.requestNote ?? "", /Undid changes to new\.ts/);
});

test("the context file records a discarded review branch, but not a merged one", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "astute-review-")));
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  fs.writeFileSync(path.join(root, "a.c"), "int a;\n");
  git("add", ".");
  git("commit", "-qm", "start");
  const branchWithWork = async (prompt: string, file: string) => {
    const review = await startReview(root, prompt);
    fs.writeFileSync(path.join(root, file), "int b;\n");
    await commitReview(root, [file], prompt);
    return { ...review, commit: "abc123", files: [file], state: "open" as const };
  };

  const workspace = vscodeStub.workspace as { workspaceFolders: unknown };
  workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  try {
    const { service } = contextService({ reply: "short", tools: ['read_file({"path":"a.c"})'] });
    const { provider, storage } = makeProvider(service);
    await provider.send("start");
    const open = provider as unknown as { transcript: TranscriptEntry[] };

    const merged = await branchWithWork("keep this", "keep.c");
    open.transcript.push({ role: "assistant", content: "done", review: merged });
    await provider.receive({ type: "reviewAction", branch: merged.branch, action: "merge" });
    assert.doesNotMatch(fs.readFileSync(contextFile(storage), "utf8"), /review branch/);

    const discarded = await branchWithWork("drop this", "drop.c");
    open.transcript.push({ role: "assistant", content: "done", review: discarded });
    await provider.receive({ type: "reviewAction", branch: discarded.branch, action: "discard" });
    assert.equal(await currentBranch(root), "main");
    assert.equal(fs.existsSync(path.join(root, "drop.c")), false);
    assert.match(fs.readFileSync(contextFile(storage), "utf8"), new RegExp(`- Discarded review branch ${discarded.branch}, so its changes are gone\\.`));
  } finally {
    workspace.workspaceFolders = undefined;
  }
});

test("a chat pushed past the saved limit takes its context file with it", async () => {
  const { service } = contextService({ reply: "short", tools: ['read_file({"path":"a.ts"})'] });
  const { provider, storage, store } = makeProvider(service);
  for (let index = 0; index < 32; index += 1) {
    await provider.send(`chat ${index}`);
    await provider.clear();
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const chats = store.get("astuteChat.chats") as Array<{ chatId: string }>;
  assert.equal(chats.length, 30);
  assert.deepEqual(fs.readdirSync(path.join(storage, "chats")).sort(), chats.map((chat) => chat.chatId).sort());
});

test("a saved chat from an older version has no context file to remove", async () => {
  const { service } = contextService({ reply: "short" });
  const { provider, store } = makeProvider(service);
  await provider.send("first");
  await provider.clear();
  const chats = store.get("astuteChat.chats") as Array<{ id: number; chatId?: string }>;
  delete chats[0].chatId;
  await provider.deleteChat(chats[0].id);
  assert.equal(provider.chatList.length, 0);
});

const PLAN_ONE = "## Goal\nAdd a cache\n\n## Steps\n1. Edit cache.ts";
const PLAN_TWO = "## Goal\nRename the logger\n\n## Steps\n1. Edit log.ts";
const PLAN_WITH_QUESTION = `${PLAN_ONE}\n\n## Open questions\n- Which cache size?`;

/** Finishes a plan with each reply in turn, and returns the replies that became plans. */
async function makePlans(provider: { receive(message: never): Promise<void>; send(text: string): Promise<void> }, options: { reply?: string }, store: Map<string, unknown>, plans: string[]): Promise<TranscriptEntry[]> {
  await provider.receive({ type: "selectMode", mode: "plan" } as never);
  for (const plan of plans) {
    options.reply = plan;
    await provider.send("plan this");
  }
  return (store.get("astuteChat.transcript") as TranscriptEntry[]).filter((entry) => entry.planId);
}

function planPath(storage: string, planId: string): string {
  return path.join(path.dirname(contextFile(storage)), `plan-${planId}.md`);
}

test("a finished plan is saved as its own file", async () => {
  const options = { reply: "short" };
  const { service } = contextService(options);
  const { provider, storage, store } = makeProvider(service);
  const [one, two] = await makePlans(provider as never, options, store, [PLAN_ONE, PLAN_TWO]);
  assert.notEqual(one.planId, two.planId);
  assert.equal(fs.readFileSync(planPath(storage, one.planId ?? ""), "utf8"), PLAN_ONE);
  assert.equal(fs.readFileSync(planPath(storage, two.planId ?? ""), "utf8"), PLAN_TWO);
});

test("only Plan replies become plans", async () => {
  const { service } = contextService({ reply: PLAN_ONE });
  const { provider, store } = makeProvider(service);
  await provider.send("a question");
  assert.equal((store.get("astuteChat.transcript") as TranscriptEntry[]).some((entry) => entry.planId), false);
});

test("a stopped plan isn't offered for implementing", async () => {
  const { provider, store } = makeProvider({
    commandSkills: () => [],
    runTurn: async ({ events }: ContextTurn) => {
      events.onContent(PLAN_ONE);
      return { model: "m", summary: "Stopped", imageText: "", cancelled: true };
    },
  });
  await provider.receive({ type: "selectMode", mode: "plan" });
  await provider.send("plan this");
  assert.equal((store.get("astuteChat.transcript") as TranscriptEntry[]).some((entry) => entry.planId), false);
});

test("Implement on an older plan carries out that plan, not the newest", async () => {
  const options = { reply: "short" };
  const { service, turns } = contextService(options);
  const { provider, store } = makeProvider(service);
  const [older] = await makePlans(provider as never, options, store, [PLAN_ONE, PLAN_TWO]);
  options.reply = "done";
  await provider.receive({ type: "implementPlan", planId: older.planId ?? "" });
  assert.match(turns.at(-1)?.systemSection ?? "", /<approved-plan>\n## Goal\nAdd a cache/);
  assert.doesNotMatch(turns.at(-1)?.systemSection ?? "", /Rename the logger/);
  assert.deepEqual((store.get("astuteChat.activePlan") as { title: string }).title, "Add a cache");
  assert.equal(store.get("astuteChat.mode"), "agent");
});

test("a pinned plan isn't sent twice, and the other plans stay in the history", async () => {
  const options = { reply: "short" };
  const { service, turns } = contextService(options);
  const { provider, store } = makeProvider(service);
  const [older] = await makePlans(provider as never, options, store, [PLAN_ONE, PLAN_TWO]);
  await provider.receive({ type: "implementPlan", planId: older.planId ?? "" });
  const history = turns.at(-1)?.history.map((message) => message.content) ?? [];
  assert.equal(history.includes(PLAN_ONE), false);
  assert.equal(history.includes(PLAN_TWO), true);
});

test("edits to a plan are what Agent receives, on every turn", async () => {
  const options = { reply: "short" };
  const { service, turns } = contextService(options);
  const { provider, storage, store } = makeProvider(service);
  const [plan] = await makePlans(provider as never, options, store, [PLAN_ONE]);
  fs.writeFileSync(planPath(storage, plan.planId ?? ""), PLAN_ONE.replace("cache.ts", "lru.ts"));
  await provider.receive({ type: "implementPlan", planId: plan.planId ?? "" });
  assert.match(turns.at(-1)?.systemSection ?? "", /Edit lru\.ts/);
  fs.writeFileSync(planPath(storage, plan.planId ?? ""), PLAN_ONE.replace("cache.ts", "store.ts"));
  await provider.send("carry on");
  assert.match(turns.at(-1)?.systemSection ?? "", /Edit store\.ts/);
});

test("a plan survives the chat being summarised", async () => {
  const options = { reply: LONG };
  const { service, turns, summarised } = contextService(options);
  const { provider, store } = makeProvider(service);
  const [plan] = await makePlans(provider as never, options, store, [PLAN_ONE]);
  await provider.receive({ type: "implementPlan", planId: plan.planId ?? "" });
  await chatLongEnoughToSummarise(provider);
  assert.ok(summarised.length > 0);
  assert.match(turns.at(-1)?.systemSection ?? "", /<approved-plan>\n## Goal\nAdd a cache/);
});

test("skipping a pinned plan keeps the summary's place in the transcript", async () => {
  const options = { reply: "short" };
  const { service, summarised } = contextService(options);
  const { provider, store } = makeProvider(service);
  const [plan] = await makePlans(provider as never, options, store, [PLAN_ONE]);
  await provider.receive({ type: "implementPlan", planId: plan.planId ?? "" });
  await chatLongEnoughToSummarise(provider);
  const { upTo } = store.get("astuteChat.summary") as { upTo: number };
  const transcript = store.get("astuteChat.transcript") as TranscriptEntry[];
  assert.equal(transcript[upTo - 1].role === "user" || transcript[upTo - 1].role === "assistant", true);
  assert.ok(summarised[0].count > 0);
  assert.ok(upTo > summarised[0].count, "the plan's own entry is passed over, not counted as a message");
});

test("the plan is only pinned in Agent mode", async () => {
  const options = { reply: "short" };
  const { service, turns } = contextService(options);
  const { provider, store } = makeProvider(service);
  const [plan] = await makePlans(provider as never, options, store, [PLAN_ONE]);
  await provider.receive({ type: "implementPlan", planId: plan.planId ?? "" });
  await provider.receive({ type: "selectMode", mode: "ask" });
  await provider.send("a question");
  assert.equal(turns.at(-1)?.systemSection, undefined);
  assert.equal(turns.at(-1)?.history.some((message) => message.content === PLAN_ONE), true);
});

test("removing the plan stops it being sent", async () => {
  const options = { reply: "short" };
  const { service, turns } = contextService(options);
  const { provider, store } = makeProvider(service);
  const [plan] = await makePlans(provider as never, options, store, [PLAN_ONE]);
  await provider.receive({ type: "implementPlan", planId: plan.planId ?? "" });
  await provider.receive({ type: "clearPlan" });
  await provider.send("next");
  assert.equal(turns.at(-1)?.systemSection, undefined);
  assert.equal(store.get("astuteChat.activePlan"), undefined);
});

test("a saved chat keeps its plan, and a new chat starts with none", async () => {
  const options = { reply: "short" };
  const { service, turns } = contextService(options);
  const { provider, store } = makeProvider(service);
  const [plan] = await makePlans(provider as never, options, store, [PLAN_ONE]);
  await provider.receive({ type: "implementPlan", planId: plan.planId ?? "" });
  await provider.clear();
  await provider.send("something else");
  assert.equal(turns.at(-1)?.systemSection, undefined);
  await provider.clear();
  const saved = provider.chatList.find((chat) => chat.title === "plan this");
  await provider.openSavedChat(saved?.id ?? 0);
  await provider.send("carry on");
  assert.match(turns.at(-1)?.systemSection ?? "", /Add a cache/);
});

test("falls back to the reply if the plan's file has gone, and restores it on opening", async () => {
  const options = { reply: "short" };
  const { service, turns } = contextService(options);
  const { provider, storage, store } = makeProvider(service);
  const [plan] = await makePlans(provider as never, options, store, [PLAN_ONE]);
  const file = planPath(storage, plan.planId ?? "");
  fs.rmSync(file);
  await provider.receive({ type: "implementPlan", planId: plan.planId ?? "" });
  assert.match(turns.at(-1)?.systemSection ?? "", /Add a cache/);
  await provider.openPlan(plan.planId ?? "");
  assert.equal(opened.at(-1), file);
  assert.equal(fs.readFileSync(file, "utf8"), PLAN_ONE);
});

test("ignores a plan id this chat doesn't have, which could otherwise reach a path", async () => {
  const options = { reply: "short" };
  const { service, turns } = contextService(options);
  const { provider, storage, store } = makeProvider(service);
  await makePlans(provider as never, options, store, [PLAN_ONE]);
  const outside = "../../../secret";
  fs.writeFileSync(path.join(path.dirname(contextFile(storage)), `plan-${outside}.md`), "a real file outside the chat's folder");
  const before = turns.length;
  const count = opened.length;
  await provider.receive({ type: "implementPlan", planId: outside });
  await provider.receive({ type: "openPlan", planId: outside });
  assert.equal(turns.length, before);
  assert.equal(opened.length, count);
  assert.equal(store.get("astuteChat.mode"), "plan");
});

test("warns when a plan is too long for the model to see all of it", async () => {
  const options = { reply: "short" };
  const { service, turns } = contextService(options);
  const { provider, store } = makeProvider(service);
  const [plan] = await makePlans(provider as never, options, store, [`${PLAN_ONE}\n${"- step\n".repeat(4000)}`]);
  await provider.receive({ type: "implementPlan", planId: plan.planId ?? "" });
  const reply = [...(store.get("astuteChat.transcript") as TranscriptEntry[])].reverse().find((entry) => entry.role === "assistant");
  assert.match(reply?.notices?.join() ?? "", /too long for the context window/);
  assert.ok((turns.at(-1)?.systemSection?.length ?? 0) < 8192);
});

test("deleting a chat removes its plans", async () => {
  const options = { reply: "short" };
  const { service } = contextService(options);
  const { provider, storage, store } = makeProvider(service);
  const [plan] = await makePlans(provider as never, options, store, [PLAN_ONE]);
  const file = planPath(storage, plan.planId ?? "");
  await provider.clear();
  await provider.deleteChat(provider.chatList[0].id);
  assert.equal(fs.existsSync(file), false);
});

test("a reply that's only a question isn't offered as a plan", async () => {
  const options = { reply: "Which database do you use?" };
  const { service } = contextService(options);
  const { provider, store } = makeProvider(service);
  await provider.receive({ type: "selectMode", mode: "plan" });
  await provider.send("plan this");
  assert.equal((store.get("astuteChat.transcript") as TranscriptEntry[]).some((entry) => entry.planId), false);
});

test("says when a plan has open questions", async () => {
  const options = { reply: "short" };
  const { service } = contextService(options);
  const { provider, store } = makeProvider(service);
  const [plan] = await makePlans(provider as never, options, store, [PLAN_WITH_QUESTION]);
  assert.match(plan.notices?.join() ?? "", /has open questions/);
});

test("open questions stop a plan until you choose to go ahead", async () => {
  const options = { reply: "short" };
  const { service, turns } = contextService(options);
  const { provider, store } = makeProvider(service);
  const [plan] = await makePlans(provider as never, options, store, [PLAN_WITH_QUESTION]);
  const before = turns.length;
  warningChoice = undefined;
  await provider.receive({ type: "implementPlan", planId: plan.planId ?? "" });
  assert.match(shownWarnings.at(-1) ?? "", /Which cache size\?/);
  assert.equal(turns.length, before);
  assert.equal(store.get("astuteChat.mode"), "plan", "nothing changed");
  warningChoice = "Implement Anyway";
  await provider.receive({ type: "implementPlan", planId: plan.planId ?? "" }).finally(() => (warningChoice = undefined));
  assert.equal(turns.length, before + 1);
});

test("answering a plan's questions by editing it clears the warning", async () => {
  const options = { reply: "short" };
  const { service, turns } = contextService(options);
  const { provider, storage, store } = makeProvider(service);
  const [plan] = await makePlans(provider as never, options, store, [PLAN_WITH_QUESTION]);
  fs.writeFileSync(planPath(storage, plan.planId ?? ""), PLAN_WITH_QUESTION.replace("- Which cache size?", "None"));
  const warned = shownWarnings.length;
  const before = turns.length;
  await provider.receive({ type: "implementPlan", planId: plan.planId ?? "" });
  assert.equal(shownWarnings.length, warned);
  assert.equal(turns.length, before + 1);
});

test("warns if planned files changed after the plan was written", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astute-plan-"));
  fs.writeFileSync(path.join(root, "cache.ts"), "// already edited, before the plan\n");
  const workspace = vscodeStub.workspace as { workspaceFolders: unknown };
  workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  try {
    const options = { reply: "short" };
    const { service, turns } = contextService(options);
    const { provider, store } = makeProvider(service);
    const [plan] = await makePlans(provider as never, options, store, ["## Goal\nCache\n\n## Files\n- cache.ts\n\n## Steps\n1. Edit it"]);
    const warned = shownWarnings.length;
    await provider.receive({ type: "implementPlan", planId: plan.planId ?? "" });
    assert.equal(shownWarnings.length, warned, "edits from before the plan don't count");

    await provider.receive({ type: "clearPlan" });
    const before = turns.length;
    fs.writeFileSync(path.join(root, "cache.ts"), "// changed since\n");
    await provider.receive({ type: "implementPlan", planId: plan.planId ?? "" });
    assert.match(shownWarnings.at(-1) ?? "", /changed since it was written: cache\.ts/);
    assert.equal(turns.length, before);
  } finally {
    workspace.workspaceFolders = undefined;
  }
});

interface StepTurn extends ContextTurn {
  prompt: string;
  signal: AbortSignal;
  confirm(request: unknown): Promise<boolean>;
}

const THREE_STEPS = "## Goal\nAdd a cache\n\n## Steps\n1. Edit cache.ts\n2. Edit client.ts\n   - keep the API\n3. Add tests\n\n## Verify\nRun npm test";

/** Finishes each step well unless told otherwise. `act` gets the step's number from 1. */
function stepService(act?: (step: number, turn: StepTurn) => Partial<{ usedTools: boolean; unresolvedFailure: boolean; hitToolLimit: boolean; cancelled: boolean; reply: string }> | Promise<unknown> | undefined) {
  const prompts: string[] = [];
  const systems: Array<string | undefined> = [];
  return {
    prompts,
    systems,
    service: {
      commandSkills: () => [],
      summaryTarget: async () => WINDOW,
      summarise: async () => "## Goal\n- ship it",
      runTurn: async (turn: StepTurn) => {
        const prepared = await turn.prepareHistory({ ...WINDOW, reservedTokens: 1000 });
        prompts.push(turn.prompt);
        systems.push(prepared.systemSection);
        const number = Number(/Do step (\d+)/.exec(turn.prompt)?.[1] ?? 0);
        const outcome = ((await act?.(number, turn)) ?? {}) as { reply?: string };
        turn.events.onContent(outcome.reply ?? "Done, and checked.");
        return { model: "m", summary: "done", imageText: "", cancelled: false, usedTools: true, ...outcome };
      },
    },
  };
}

/** Makes a plan in Plan mode, then starts it. */
async function startPlan(provider: { receive(message: never): Promise<void>; send(text: string): Promise<void> }, store: Map<string, unknown>, service: { runTurn(turn: never): Promise<unknown> }, plan = THREE_STEPS): Promise<void> {
  const real = service.runTurn;
  service.runTurn = (async (turn: ContextTurn) => {
    await turn.prepareHistory({ ...WINDOW, reservedTokens: 1000 });
    turn.events.onContent(plan);
    return { model: "m", summary: "done", imageText: "", cancelled: false };
  }) as never;
  await provider.receive({ type: "selectMode", mode: "plan" } as never);
  await provider.send("plan this");
  service.runTurn = real;
  const entry = (store.get("astuteChat.transcript") as TranscriptEntry[]).find((candidate) => candidate.planId);
  await provider.receive({ type: "implementPlan", planId: entry?.planId ?? "" } as never);
}

/** Waits for something a running plan does, because saving files takes a varying time. */
async function until(happened: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !happened(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(happened(), "it never happened");
}

const transcriptOf = (store: Map<string, unknown>) => store.get("astuteChat.transcript") as TranscriptEntry[];
const activeDone = (store: Map<string, unknown>) => (store.get("astuteChat.activePlan") as { done: number } | undefined)?.done;
const lastInfo = (store: Map<string, unknown>) => [...transcriptOf(store)].reverse().find((entry) => entry.role === "info")?.content ?? "";

test("runs a plan one turn per step, in order, then checks the work and lets the plan go", async () => {
  const { service, prompts, systems } = stepService();
  const { provider, store } = makeProvider(service);
  await startPlan(provider as never, store, service as never);
  assert.equal(prompts.length, 4);
  assert.match(prompts[0], /Do step 1 of 4[^\n]*\nEdit cache\.ts/);
  assert.match(prompts[1], /Do step 2 of 4[^\n]*\nEdit client\.ts\n- keep the API/);
  assert.match(prompts[3], /Check the finished work: Run npm test/);
  assert.ok(systems.every((system) => system?.includes("<approved-plan>")), "every step can see the whole plan");
  assert.equal(store.get("astuteChat.activePlan"), undefined);
  assert.match(lastInfo(store), /Plan finished: all 4 steps ran/);
  assert.match(transcriptOf(store).find((entry) => entry.content.startsWith("Step 2"))?.content ?? "", /^Step 2 of 4: Edit client\.ts$/);
});

for (const [name, outcome, reason] of [
  ["a failure left behind", { unresolvedFailure: true }, /still failing/],
  ["running out of tool rounds", { hitToolLimit: true }, /ran out of tool rounds/],
  ["a step with no tools used", { usedTools: false }, /didn't use any tools/],
  ["a claim of success with no tools", { usedTools: false, reply: "All done!" }, /didn't use any tools/],
  ["a question", { reply: "Which file should I use?" }, /has a question/],
  ["being stopped", { cancelled: true }, /You stopped it/],
] as const) {
  test(`pauses on ${name}, without counting the step`, async () => {
    const { service, prompts } = stepService((step) => (step === 2 ? outcome : undefined));
    const { provider, store } = makeProvider(service);
    await startPlan(provider as never, store, service as never);
    assert.equal(prompts.length, 2, "later steps don't run");
    assert.equal(activeDone(store), 1);
    assert.match(lastInfo(store), reason);
    assert.match(lastInfo(store), /Paused at step 2 of 4/);
  });
}

test("pauses when a change is denied, even if the model carries on and says it's done", async () => {
  const { service, prompts } = stepService(async (step, turn) => {
    if (step === 1) {
      await turn.confirm({ kind: "edit", title: "Edit?", detail: "a.ts", file: "a.ts" });
    }
    return undefined;
  });
  const { provider, store } = makeProvider(service);
  const running = startPlan(provider as never, store, service as never);
  await until(() => provider.pendingApprovalId !== undefined);
  await provider.receive({ type: "approvalDecision", id: provider.pendingApprovalId ?? 0, decision: "deny" });
  await running;
  assert.equal(prompts.length, 1);
  assert.equal(activeDone(store), 0);
  assert.match(lastInfo(store), /A change was denied/);
});

test("pauses when a turn throws, and keeps the step", async () => {
  const { service, prompts } = stepService((step) => {
    if (step === 2) {
      throw new Error("Ollama went away.");
    }
    return undefined;
  });
  const { provider, store } = makeProvider(service);
  await startPlan(provider as never, store, service as never);
  assert.equal(prompts.length, 2);
  assert.equal(activeDone(store), 1);
  assert.match(lastInfo(store), /Ollama went away\./);
});

test("Continue tries the paused step again, says so, and finishes the plan", async () => {
  let failing = true;
  const { service, prompts } = stepService((step) => (step === 2 && failing ? { hitToolLimit: true } : undefined));
  const { provider, store } = makeProvider(service);
  await startPlan(provider as never, store, service as never);
  failing = false;
  await provider.receive({ type: "continuePlan" });
  assert.match(prompts[2], /Do step 2 of 4/);
  assert.match(prompts[2], /wasn't finished last time/);
  assert.doesNotMatch(prompts[3], /wasn't finished last time/);
  assert.equal(prompts.filter((prompt) => prompt.includes("Do step 1")).length, 1, "finished steps aren't repeated");
  assert.equal(store.get("astuteChat.activePlan"), undefined);
});

test("you can answer a question in the chat, then Continue", async () => {
  let asking = true;
  const { service, prompts, systems } = stepService((step) => (step === 1 && asking ? { reply: "Which cache size?" } : undefined));
  const { provider, store } = makeProvider(service);
  await startPlan(provider as never, store, service as never);
  asking = false;
  await provider.send("Use 100 entries.");
  assert.equal(prompts.at(-1), "Use 100 entries.");
  assert.match(systems.at(-1) ?? "", /<approved-plan>/);
  assert.equal(activeDone(store), 0, "a chat reply doesn't finish a step");
  await provider.receive({ type: "continuePlan" });
  assert.equal(store.get("astuteChat.activePlan"), undefined);
});

test("selecting Implement on a part-done plan picks it up instead of starting over", async () => {
  let failing = true;
  const { service, prompts } = stepService((step) => (step === 2 && failing ? { hitToolLimit: true } : undefined));
  const { provider, store } = makeProvider(service);
  await startPlan(provider as never, store, service as never);
  failing = false;
  const entry = transcriptOf(store).find((candidate) => candidate.planId);
  await provider.receive({ type: "implementPlan", planId: entry?.planId ?? "" });
  assert.equal(prompts.filter((prompt) => prompt.includes("Do step 1")).length, 1);
});

test("edits to the plan during a pause are followed", async () => {
  let failing = true;
  const { service, prompts } = stepService((step) => (step === 2 && failing ? { hitToolLimit: true } : undefined));
  const { provider, storage, store } = makeProvider(service);
  await startPlan(provider as never, store, service as never);
  failing = false;
  const entry = transcriptOf(store).find((candidate) => candidate.planId);
  fs.writeFileSync(planPath(storage, entry?.planId ?? ""), THREE_STEPS.replace("Edit client.ts", "Edit server.ts"));
  await provider.receive({ type: "continuePlan" });
  assert.match(prompts[2], /Edit server\.ts/);
});

test("Continue does nothing with no plan, or while a step is running", async () => {
  let release = (): void => undefined;
  const { service, prompts } = stepService((step) => (step === 1 ? new Promise<void>((resolve) => (release = resolve)) : undefined));
  const { provider, store } = makeProvider(service);
  await provider.receive({ type: "continuePlan" });
  assert.equal(prompts.length, 0);
  const running = startPlan(provider as never, store, service as never);
  await until(() => prompts.length === 1);
  await provider.receive({ type: "continuePlan" });
  await provider.send("too soon");
  assert.equal(prompts.length, 1);
  release();
  await running;
  assert.equal(prompts.length, 4);
});

test("New Chat stops a running plan", async () => {
  const { service, prompts } = stepService((step, turn) => (step === 1 ? new Promise((resolve) => turn.signal.addEventListener("abort", () => resolve({ cancelled: true }))) : undefined));
  const { provider, store } = makeProvider(service);
  const running = startPlan(provider as never, store, service as never);
  await until(() => prompts.length === 1);
  await provider.clear();
  await running;
  assert.equal(prompts.length, 1);
  assert.equal(store.get("astuteChat.activePlan"), undefined);
});

test("removing the plan between steps stops the rest", async () => {
  let release = (): void => undefined;
  const { service, prompts } = stepService((step) => (step === 1 ? new Promise<void>((resolve) => (release = resolve)) : undefined));
  const { provider, store } = makeProvider(service);
  const running = startPlan(provider as never, store, service as never);
  await until(() => prompts.length === 1);
  await provider.receive({ type: "clearPlan" });
  release();
  await running;
  assert.equal(prompts.length, 1);
  assert.equal(store.get("astuteChat.activePlan"), undefined, "finishing the step doesn't bring it back");
  assert.equal(provider.chatRows.length > 0, true);
});

test("a saved chat comes back paused, and can be continued", async () => {
  let failing = true;
  const { service, prompts } = stepService((step) => (step === 2 && failing ? { hitToolLimit: true } : undefined));
  const { provider, store } = makeProvider(service);
  await startPlan(provider as never, store, service as never);
  failing = false;
  await provider.clear();
  await provider.openSavedChat(provider.chatList[0].id);
  await provider.receive({ type: "continuePlan" });
  assert.equal(prompts.filter((prompt) => prompt.includes("Do step 1")).length, 1);
  assert.equal(store.get("astuteChat.activePlan"), undefined);
});

test("New Chat as a step finishes stops the plan, and the next step can't land in the new chat", async () => {
  let cleared: Promise<void> | undefined;
  const { service, prompts } = stepService((step) => {
    if (step === 1) {
      cleared = provider.clear();
    }
    return undefined;
  });
  const { provider, store } = makeProvider(service);
  await startPlan(provider as never, store, service as never);
  await cleared;
  assert.equal(prompts.length, 1, "the step ended normally, and nothing else ran");
  assert.equal(store.get("astuteChat.activePlan"), undefined);
  assert.deepEqual(transcriptOf(store), [], "the new chat is empty");
});
