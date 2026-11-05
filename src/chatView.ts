import * as crypto from "crypto";
import * as vscode from "vscode";
import { ChangeRequest, decide } from "./approvals";
import { ChangeJournal } from "./changeJournal";
import { activityLine, ChatContext, ChatContextStore, cleanSummary, EMPTY_CONTEXT, planTitle, recentActivity } from "./chatContext";
import { ChatService, HistoryBudget, PreparedHistory, SummaryTarget } from "./chatService";
import { capText, messagesBeforeRecent, messagesToSummarise, notesSection, notesTokens, planSection, planTokens, recentWorkNote, summarySection, summaryTokens } from "./chatSummary";
import { estimateTokens } from "./chatEngine";
import { getChatSettings } from "./config";
import type { ConnectionMonitor } from "./connection";
import { IMAGE_FILE } from "./contentGuard";
import { openWorkspaceFile, readDroppedImages, resolveFiles, workspacePath } from "./fileResolver";
import { buildRequestContext, OpenFile } from "./contextFiles";
import { rankFiles, withFolders } from "./filePicker";
import { changedPlanFiles, hashPlanFiles, isPlan, openQuestions, planSteps, stepProblem } from "./planCheck";
import { ActivePlan, ApprovalDecision, ApprovalPrompt, AttachedImage, ChatListing, FromWebview, QueuedMessage, ToWebview, TranscriptEntry, ViewState } from "./messages";
import { ApprovalLevel, ChatMode, isApprovalLevel, isChatMode, MODES } from "./modes";
import { ChatMessage, OllamaError } from "./ollamaClient";
import { isSensitivePath } from "./pathGuard";
import { findRepo } from "./repoInfo";
import { baseVersion, commitReview, currentBranch, discardReview, dropEmptyReview, latestCommit, mergeReview, ReviewBranch, reviewBlocker, reviewFiles, startReview } from "./reviewBranch";
import { ChatRow, chatRows, chatTitle } from "./savedChats";
import { parseSlash, Skill } from "./skillLoader";

const STORAGE_KEY = "astuteChat.transcript";
const MODE_KEY = "astuteChat.mode";
const APPROVAL_KEY = "astuteChat.approval";
const PROPOSED_SCHEME = "astute-proposed";
const SUMMARY_KEY = "astuteChat.summary";
const CHAT_ID_KEY = "astuteChat.chatId";
const ACTIVE_PLAN_KEY = "astuteChat.activePlan";
const MAX_STEP_LABEL_CHARS = 100;
const REVIEW_MODE_KEY = "astuteChat.reviewMode";
const OPEN_REVIEW_KEY = "astuteChat.openReview";
const CHATS_KEY = "astuteChat.chats";
const MAX_SAVED_CHATS = 30;
const MAX_SAVED_TOOL_CHARS = 8000;
const FILE_LIST_LIFETIME_MS = 30000;
const MAX_LISTED_FILES = 3000;
const MAX_STORED_ENTRIES = 200;
const MAX_SELECTION_CHARS = 12000;

interface PendingApproval {
  prompt: ApprovalPrompt;
  request: ChangeRequest;
  settle(decision: ApprovalDecision): void;
}

/** How far into the transcript the context file covers. Older versions kept the text here too. */
interface SummaryState {
  upTo: number;
  text?: string;
}

interface SavedChat extends ChatListing {
  /** Names the context file. Missing from chats saved by older versions. */
  chatId?: string;
  transcript: TranscriptEntry[];
  summary?: SummaryState;
  activePlan?: ActivePlan;
}

/** A message for the model, and where it came from in the transcript. */
interface HistoryEntry {
  index: number;
  message: ChatMessage;
}

/** Large tool calls would fill workspace storage, so saved chats keep only their names. */
function compactEntry(entry: TranscriptEntry): TranscriptEntry {
  return entry.tools ? { ...entry, undoId: undefined, tools: entry.tools.map((call) => (call.length > MAX_SAVED_TOOL_CHARS ? `${call.split("(")[0]}({})` : call)) } : { ...entry, undoId: undefined };
}

function selectionContext(): { context: string; note: string } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return undefined;
  }
  const { selection, document } = editor;
  const file = vscode.workspace.asRelativePath(document.uri);
  // A selection is an easy way to send a secret by accident, so the rule for files applies here too.
  if (isSensitivePath(document.uri.fsPath)) {
    return { note: `Selection from ${file} wasn't sent, because that file may hold secrets.`, context: "" };
  }
  const range = `${selection.start.line + 1}-${selection.end.line + 1}`;
  const text = document.getText(selection).slice(0, MAX_SELECTION_CHARS);
  return {
    note: `Selection: ${file}:${range}`,
    context: `\n\nSelected code from ${file}, lines ${range}:\n\`\`\`${document.languageId}\n${text}\n\`\`\``,
  };
}

function openFile(): OpenFile | undefined {
  const document = vscode.window.activeTextEditor?.document;
  return document?.uri.scheme === "file" ? { file: vscode.workspace.asRelativePath(document.uri), language: document.languageId, text: document.getText() } : undefined;
}

/** Serves the text an Agent change would produce, for VS Code's diff view. */
class ProposedChanges implements vscode.TextDocumentContentProvider {
  private readonly documents = new Map<string, string>();

  add(file: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: file, query: String(this.documents.size) });
    this.documents.set(uri.toString(), content);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? "";
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "astuteChat.chatView";

  private view: vscode.WebviewView | undefined;
  private transcript: TranscriptEntry[];
  private mode: ChatMode;
  private approval: ApprovalLevel;
  private pending: PendingApproval | undefined;
  private queue: QueuedMessage[] = [];
  /** A stop or a failure hands waiting messages back, so nothing starts by itself. */
  private holdQueue = false;
  private nextQueueId = 1;
  private pinned: Array<{ file: string; shown: string }> = [];
  private hiddenOpenFile: string | undefined;
  private readonly journals = new Map<number, ChangeJournal>();
  private readonly proposed = new ProposedChanges();
  private nextUndoId = 1;
  private chats: SavedChat[];
  private chatKey = 0;
  private reviewMode: boolean;
  private openReview: (ReviewBranch & { root: string }) | undefined;
  private summary: SummaryState | undefined;
  private chatId: string;
  private readonly contextFiles: ChatContextStore;
  private updatingContext = false;
  private contextUse: number | undefined;
  private activePlan: ActivePlan | undefined;
  private planRunning = false;
  /** Why the turn that just ended can't count as a finished step. */
  private turnProblem: string | undefined;
  private fileList: { items: string[]; at: number } | undefined;
  private nextApprovalId = 1;
  private active: TranscriptEntry | undefined;
  private status: string | undefined;
  private abort: AbortController | undefined;
  private turn: Promise<void> | undefined;
  private readonly chatsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeChats = this.chatsChanged.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: ChatService,
    private readonly monitor: ConnectionMonitor,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.transcript = context.workspaceState.get<TranscriptEntry[]>(STORAGE_KEY, []);
    const savedMode = context.workspaceState.get<string>(MODE_KEY);
    this.mode = isChatMode(savedMode) ? savedMode : "ask";
    this.summary = context.workspaceState.get(SUMMARY_KEY);
    this.chatId = context.workspaceState.get<string>(CHAT_ID_KEY) ?? crypto.randomUUID();
    this.activePlan = context.workspaceState.get<ActivePlan>(ACTIVE_PLAN_KEY);
    this.contextFiles = new ChatContextStore((context.storageUri ?? context.globalStorageUri).fsPath);
    this.chats = context.workspaceState.get<SavedChat[]>(CHATS_KEY, []);
    this.reviewMode = context.workspaceState.get<boolean>(REVIEW_MODE_KEY, false);
    this.openReview = context.workspaceState.get(OPEN_REVIEW_KEY);
    const savedApproval = context.workspaceState.get<string>(APPROVAL_KEY);
    this.approval = isApprovalLevel(savedApproval) ? savedApproval : "ask";
    context.subscriptions.push(this.chatsChanged);
    context.subscriptions.push(monitor.onDidChange(() => this.postState()));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => this.postState()));
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this.proposed));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    // Set html first. In the other order VS Code loads an empty page, and logs a missing CSP.
    view.webview.html = this.html(view.webview, media);
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.onDidReceiveMessage((message: FromWebview) => void this.receive(message));
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"));
    const nonce = crypto.randomBytes(16).toString("base64");
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src data:;`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style}">
<title>Astute Code</title>
</head>
<body>
<header>
  <select id="model" aria-label="Model"></select>
  <button id="history" type="button" class="secondary icon" title="Chat history" aria-label="Chat history" aria-expanded="false">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>
  </button>
  <button id="chat-context" type="button" class="secondary icon" title="Open chat context" aria-label="Open chat context">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>
  </button>
  <button id="new-chat" type="button" class="secondary icon" title="New chat" aria-label="New chat">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z"/><path d="M12 6.5v6M9 9.5h6"/></svg>
  </button>
</header>
<div id="history-list" hidden></div>
<div id="banner" hidden></div>
<div id="dropzone" hidden>Drop image to attach</div>
<main id="messages" aria-live="polite"></main>
<section id="approval" hidden aria-label="Approval needed"></section>
<div id="status" hidden><span class="pulse" aria-hidden="true"></span><span id="status-text"></span></div>
<form id="composer">
  <div id="picker" role="listbox" aria-label="Workspace files" hidden></div>
  <div id="queue" hidden></div>
  <div id="context" hidden></div>
  <div id="attachments" hidden></div>
  <textarea id="input" rows="3" aria-label="Message" ></textarea>
  <div class="actions">
    <select id="mode" aria-label="Mode"></select>
    <button id="approvals" type="button" class="secondary compact"></button>
    <span class="spacer"></span>
    <span id="context-use" hidden></span>
    <button id="review-mode" type="button" class="secondary compact" aria-pressed="false">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-6 3-10 5"/></svg>
      <span>Review</span>
    </button>
    <button id="full-auto" type="button" class="secondary compact" aria-pressed="false">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>
      <span>Auto</span>
    </button>
    <button id="send" type="submit">Send</button>
    <button id="stop" type="button" aria-label="Stop" title="Stop (Esc)" hidden></button>
  </div>
</form>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private post(message: ToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private viewState(): ViewState {
    const connection = this.monitor.state;
    return {
      connection: connection.status,
      connectionMessage: connection.message,
      server: connection.server,
      insecureRemote: connection.insecureRemote,
      models: connection.models.map((model) => model.name),
      abilities: connection.abilities,
      undoable: [...this.journals.keys()],
      model: getChatSettings().model,
      mode: this.mode,
      approval: this.approval,
      reviewMode: this.reviewMode,
      pendingApproval: this.pending?.prompt,
      busy: Boolean(this.active),
      transcript: this.transcript,
      chatKey: this.chatKey,
      chats: this.chatList,
      active: this.active,
      openFile: this.includedOpenFile()?.file,
      pinned: this.pinned.map((item) => item.shown),
      status: this.status,
      contextUse: this.contextUse,
      activePlan: this.activePlan,
      planRunning: this.planRunning,
      queued: this.queuedForView(),
    };
  }

  postState(): void {
    this.post({ type: "state", state: this.viewState() });
  }

  private async persist(): Promise<void> {
    const removed = Math.max(0, this.transcript.length - MAX_STORED_ENTRIES);
    this.transcript = this.transcript.slice(-MAX_STORED_ENTRIES);
    if (this.summary) {
      this.summary = { ...this.summary, upTo: Math.max(0, this.summary.upTo - removed) };
    }
    await this.context.workspaceState.update(SUMMARY_KEY, this.summary);
    await this.context.workspaceState.update(CHAT_ID_KEY, this.chatId);
    await this.context.workspaceState.update(ACTIVE_PLAN_KEY, this.activePlan);
    await this.context.workspaceState.update(STORAGE_KEY, this.transcript);
    this.chatsChanged.fire();
  }

  async receive(message: FromWebview): Promise<void> {
    switch (message.type) {
      case "ready":
        this.log.info("Chat panel ready.");
        this.postState();
        break;
      case "send":
        await this.submit(message.text, message.images);
        break;
      case "removeQueued":
        this.queue = this.queue.filter((item) => item.id !== message.id);
        this.postQueue();
        break;
      case "stop":
        this.stop();
        break;
      case "attachDropped":
        await this.addDropped(message.uris);
        break;
      case "resolveFiles":
        this.post({ type: "filesResolved", id: message.id, files: await resolveFiles(message.references) });
        break;
      case "openFile":
        if (!(await openWorkspaceFile(message.file, message.line, message.column))) {
          void vscode.window.showWarningMessage("That file is no longer in this workspace.");
        }
        break;
      case "copyText":
        await vscode.env.clipboard.writeText(message.text);
        break;
      case "runInTerminal":
        this.runInTerminal(message.text);
        break;
      case "searchFiles":
        this.post({ type: "fileMatches", id: message.id, items: await this.matchFiles(message.query) });
        break;
      case "addContextPath":
        await this.addContextPath(message.item);
        break;
      case "showDiff":
        await this.showDiff(message.id);
        break;
      case "undoTurn":
        await this.undoTurn(message.id);
        break;
      case "removeContext":
        this.removeContext(message.item);
        break;
      case "newChat":
        await this.clear();
        break;
      case "toggleReview":
        this.reviewMode = !this.reviewMode;
        await this.context.workspaceState.update(REVIEW_MODE_KEY, this.reviewMode);
        this.postState();
        break;
      case "reviewAction":
        await this.reviewAction(message.branch, message.action);
        break;
      case "openContext":
        await this.openContext();
        break;
      case "openChat":
        await this.openSavedChat(message.id);
        break;
      case "deleteChat":
        await this.deleteChat(message.id);
        break;
      case "selectApproval":
        await this.setApproval(message.level);
        break;
      case "approvalDecision":
        if (this.pending?.prompt.id === message.id) {
          this.pending.settle(message.decision);
        }
        break;
      case "selectModel":
        await this.service.switchModel(message.model);
        this.postState();
        break;
      case "selectMode":
        await this.setMode(message.mode);
        break;
      case "implementPlan":
        await this.implementPlan(message.planId);
        break;
      case "openPlan":
        await this.openPlan(message.planId);
        break;
      case "clearPlan":
        this.activePlan = undefined;
        this.planRunning = false;
        await this.persist();
        this.postState();
        break;
      case "continuePlan":
        await this.runPlan();
        break;
      case "setServer":
        await vscode.commands.executeCommand("astuteChat.setServerAddress");
        break;
      case "retry":
        await this.monitor.refresh();
        break;
    }
  }

  private includedOpenFile(): OpenFile | undefined {
    const open = openFile();
    return open && open.file !== this.hiddenOpenFile ? open : undefined;
  }

  private removeContext(item: string): void {
    if (this.pinned.some((pin) => pin.shown === item)) {
      this.pinned = this.pinned.filter((pin) => pin.shown !== item);
    } else {
      this.hiddenOpenFile = item;
    }
    this.postState();
  }

  /** Adds Explorer files and folders to the chat. VS Code offers no way to read the selection itself. */
  async addContext(uris: readonly vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      const file = await workspacePath(uri.fsPath);
      const shown = file ? vscode.workspace.asRelativePath(uri, false) : undefined;
      if (file && shown && !this.pinned.some((pin) => pin.file === file)) {
        this.pinned.push({ file, shown });
      }
    }
    this.postState();
  }

  private async addDropped(uris: string[]): Promise<void> {
    const isImage = (uri: string): boolean => IMAGE_FILE.test(uri);
    await this.addContext(uris.filter((uri) => !isImage(uri)).map((uri) => vscode.Uri.parse(uri)));
    const images = uris.filter(isImage);
    if (images.length) {
      this.post({ type: "droppedImages", ...(await readDroppedImages(images)) });
    }
  }

  private setOpenReview(review: (ReviewBranch & { root: string }) | undefined): Thenable<void> {
    this.openReview = review;
    return this.context.workspaceState.update(OPEN_REVIEW_KEY, review);
  }

  /** Puts Agent on a review branch, or says why it's working where it is. */
  private async beginReview(prompt: string, active: TranscriptEntry): Promise<(ReviewBranch & { root: string }) | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const repo = folder ? await findRepo(folder) : undefined;
    const say = (text: string): void => {
      active.notices?.push(text);
      this.post({ type: "notice", text });
    };
    if (!repo) {
      say("Review mode is on, but this isn't a Git repository, so Agent is working on the files directly.");
      return undefined;
    }
    if (this.openReview?.root === repo.root && (await currentBranch(repo.root)) === this.openReview.branch) {
      return this.openReview;
    }
    const blocker = await reviewBlocker(repo.root);
    if (blocker) {
      say(`${blocker} Agent is working on the current branch.`);
      return undefined;
    }
    const review = { ...(await startReview(repo.root, prompt)), root: repo.root };
    await this.setOpenReview(review);
    return review;
  }

  /** Commits Agent's files to the review branch and records what's there. */
  private async finishReview(review: ReviewBranch & { root: string }, prompt: string, files: string[], active: TranscriptEntry): Promise<boolean> {
    try {
      if ((await currentBranch(review.root)) !== review.branch) {
        active.notices?.push(`Agent left the ${review.branch} branch, so nothing was committed to it.`);
        return false;
      }
      await commitReview(review.root, files, `Astute Agent: ${prompt.replace(/\s+/g, " ").slice(0, 60)}`);
      const changed = await reviewFiles(review.root, review);
      if (changed.length === 0) {
        await dropEmptyReview(review.root, review);
        await this.setOpenReview(undefined);
        return false;
      }
      active.review = { branch: review.branch, base: review.base, commit: await latestCommit(review.root), files: changed, state: "open" };
      return true;
    } catch (error) {
      active.notices?.push(`Couldn't commit to ${review.branch}: ${error instanceof Error ? error.message : "unknown error"}`);
      return false;
    }
  }

  private async reviewAction(branch: string, action: "diff" | "merge" | "discard"): Promise<void> {
    const entries = this.transcript.filter((entry) => entry.review?.branch === branch);
    const latest = entries[entries.length - 1]?.review;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const repo = folder ? await findRepo(folder) : undefined;
    if (!latest || !repo || this.active) {
      return;
    }
    try {
      if (action === "diff") {
        const resources = await Promise.all(latest.files.map(async (file) => {
          const uri = vscode.Uri.file(`${repo.root}/${file}`);
          return [uri, this.proposed.add(`${repo.root}/${file}.base`, await baseVersion(repo.root, latest, file)), uri];
        }));
        await vscode.commands.executeCommand("vscode.changes", `Review ${branch}`, resources);
        return;
      }
      if (action === "merge") {
        await mergeReview(repo.root, latest);
      } else {
        await discardReview(repo.root, latest);
      }
      await this.setOpenReview(undefined);
      if (action === "discard") {
        await this.noteActivity(`- Discarded review branch ${branch}, so its changes are gone.`);
      }
      for (const entry of entries) {
        if (entry.review) {
          entry.review.state = action === "merge" ? "merged" : "discarded";
        }
      }
      this.chatKey += 1;
      await this.info(action === "merge" ? `Merged ${branch} into ${latest.base}.` : `Discarded ${branch}, and returned to ${latest.base}.`);
    } catch (error) {
      await this.info(`Couldn't ${action} ${branch}: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}. Your files are unchanged.`);
    }
  }

  /** The newest reply in this chat. */
  get lastReply(): TranscriptEntry | undefined {
    return this.transcript.filter((entry) => entry.role === "assistant").at(-1);
  }

  /** Replies that can still be undone, oldest first. */
  get undoIds(): number[] {
    return [...this.journals.keys()];
  }

  /** Files and folders for the @ picker. The list is reused briefly, so typing stays fast. */
  async matchFiles(query: string): Promise<string[]> {
    if (!this.fileList || Date.now() - this.fileList.at > FILE_LIST_LIFETIME_MS) {
      const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,out,dist,build,.venv,__pycache__,.vscode-test}/**", MAX_LISTED_FILES);
      const names = uris.map((uri) => vscode.workspace.asRelativePath(uri, false)).filter((name) => !isSensitivePath(name));
      this.fileList = { items: withFolders(names), at: Date.now() };
    }
    return rankFiles(this.fileList.items, query);
  }

  async addContextPath(item: string): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uri = vscode.Uri.joinPath(folder.uri, item.replace(/\/$/, ""));
      if (await workspacePath(uri.fsPath)) {
        await this.addContext([uri]);
        return;
      }
    }
  }

  async showDiff(id: number): Promise<void> {
    const request = this.pending?.prompt.id === id ? this.pending.request : undefined;
    if (!request?.file || request.proposed === undefined) {
      return;
    }
    const exists = await vscode.workspace.fs.stat(vscode.Uri.file(request.file)).then(
      () => true,
      () => false,
    );
    const left = exists ? vscode.Uri.file(request.file) : this.proposed.add(`${request.file}.empty`, "");
    const name = request.path ?? request.file;
    await vscode.commands.executeCommand("vscode.diff", left, this.proposed.add(request.file, request.proposed), `${name}: proposed change`, { preview: true, preserveFocus: true });
  }

  private async undoTurn(id: number): Promise<void> {
    const journal = this.journals.get(id);
    if (!journal) {
      return;
    }
    const { restored, skipped } = await journal.undo();
    this.journals.delete(id);
    const parts = [restored.length ? `Undid changes to ${restored.join(", ")}.` : "Nothing was undone."];
    if (skipped.length) {
      parts.push(`Left ${skipped.join(", ")} alone, because ${skipped.length === 1 ? "it has" : "they have"} changed since.`);
    }
    this.log.info(parts.join(" "));
    await this.noteActivity(`- ${parts.join(" ")}`);
    await this.info(parts.join(" "));
  }

  /** The id of the approval waiting for a decision, if any. */
  get pendingApprovalId(): number | undefined {
    return this.pending?.prompt.id;
  }

  /** Uses the open terminal, or opens one in the workspace if there is none. */
  private runInTerminal(text: string): void {
    const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: "Astute Code", cwd: vscode.workspace.workspaceFolders?.[0]?.uri });
    terminal.show(true);
    terminal.sendText(text, true);
    this.log.info(`Sent to terminal "${terminal.name}": ${text}`);
  }

  stop(): void {
    this.holdQueue = this.busy;
    this.abort?.abort();
  }

  private queuedForView(): ViewState["queued"] {
    return this.queue.map(({ id, text, guide, images }) => ({ id, text: text || `${images?.length ?? 0} image(s)`, guide }));
  }

  private postQueue(): void {
    this.post({ type: "queue", items: this.queuedForView() });
  }

  private clearQueue(): void {
    this.queue = [];
    this.holdQueue = false;
  }

  /**
   * While a reply runs, a message guides it. Commands and images need a request of
   * their own, so they wait for it to end. Neither ever settles an approval.
   */
  async submit(text: string, images: AttachedImage[] = []): Promise<void> {
    if (!this.busy) {
      await this.send(text, images);
      return;
    }
    const trimmed = text.trim();
    if (trimmed || images.length) {
      const guide = !images.length && !trimmed.startsWith("/");
      this.queue.push({ id: this.nextQueueId++, text: trimmed, guide, images: images.length ? images : undefined });
      this.postQueue();
    }
  }

  /** Anything that missed its reply runs next, or goes back to the message box if the reply was stopped. */
  private async drainQueue(): Promise<void> {
    if (this.busy) {
      return;
    }
    const held = this.holdQueue;
    this.holdQueue = false;
    if (!this.queue.length) {
      return;
    }
    if (held) {
      const text = this.queue.map((item) => item.text).filter(Boolean).join("\n");
      this.post({ type: "restoreDraft", text, images: this.queue.flatMap((item) => item.images ?? []) });
      this.queue = [];
      this.postQueue();
      return;
    }
    const next = this.queue.shift() as QueuedMessage;
    this.postQueue();
    await this.send(next.text, next.images);
    await this.drainQueue();
  }

  private startQueue(): void {
    this.drainQueue().catch((error: unknown) => this.log.error(`Could not run a queued message: ${String(error)}`));
  }

  private async setApproval(level: ApprovalLevel): Promise<void> {
    this.approval = level;
    await this.context.workspaceState.update(APPROVAL_KEY, level);
    if (this.pending && decide(level, this.pending.request, getChatSettings().allowedCommands).allow) {
      this.pending.settle("allow");
    }
    this.postState();
  }

  /** Shows an approval card and waits. Stop counts as a denial. */
  private requestApproval(request: ChangeRequest, reason: string | undefined, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) {
      return Promise.resolve("deny");
    }
    return new Promise((resolve) => {
      const prompt: ApprovalPrompt = { id: this.nextApprovalId++, kind: request.kind, title: request.title, detail: request.detail, reason, canDiff: request.proposed !== undefined };
      const onAbort = (): void => settle("deny");
      const settle = (decision: ApprovalDecision): void => {
        signal.removeEventListener("abort", onAbort);
        this.pending = undefined;
        this.post({ type: "approvalDone", id: prompt.id });
        resolve(decision);
      };
      signal.addEventListener("abort", onAbort);
      this.pending = { prompt, request, settle };
      this.post({ type: "approval", prompt });
      if (this.view) {
        this.view.show(true);
      } else {
        void vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
      }
    });
  }

  private async setMode(mode: ChatMode): Promise<void> {
    this.mode = mode;
    await this.context.workspaceState.update(MODE_KEY, mode);
    this.postState();
  }

  get chatList(): ChatListing[] {
    return this.chats.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get chatRows(): ChatRow[] {
    return chatRows(chatTitle(this.transcript), this.chatList);
  }

  /** Moves the current chat into the saved list, if it has anything in it. */
  private saveCurrentChat(): void {
    const title = chatTitle(this.transcript);
    if (title === undefined) {
      return;
    }
    const id = Math.max(0, ...this.chats.map((chat) => chat.id)) + 1;
    this.chats.push({ id, chatId: this.chatId, title, updatedAt: Date.now(), transcript: this.transcript.map(compactEntry), summary: this.summary, activePlan: this.activePlan });
    this.chats.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const chat of this.chats.splice(MAX_SAVED_CHATS)) {
      void this.deleteContextFile(chat);
    }
  }

  private async deleteContextFile(chat: SavedChat): Promise<void> {
    await (chat.chatId ? this.contextFiles.remove(chat.chatId) : undefined)?.catch((error: unknown) => this.log.warn(`Could not remove a chat context file: ${String(error)}`));
  }

  /** Returns false if the chat can't be opened yet, because a reply is still running. */
  async openSavedChat(id: number): Promise<boolean> {
    const chat = this.chats.find((candidate) => candidate.id === id);
    if (!chat || this.busy) {
      return !this.busy;
    }
    this.chats = this.chats.filter((candidate) => candidate.id !== id);
    this.saveCurrentChat();
    this.transcript = chat.transcript;
    this.summary = chat.summary;
    this.chatId = chat.chatId ?? crypto.randomUUID();
    this.activePlan = chat.activePlan;
    this.contextUse = undefined;
    this.pinned = [];
    this.hiddenOpenFile = undefined;
    this.journals.clear();
    this.clearQueue();
    this.chatKey += 1;
    await this.context.workspaceState.update(CHATS_KEY, this.chats);
    await this.persist();
    this.postState();
    return true;
  }

  async deleteChat(id: number): Promise<void> {
    const deleted = this.chats.find((chat) => chat.id === id);
    this.chats = this.chats.filter((chat) => chat !== deleted);
    if (deleted) {
      await this.deleteContextFile(deleted);
    }
    await this.context.workspaceState.update(CHATS_KEY, this.chats);
    this.chatsChanged.fire();
    this.postState();
  }

  async clear(): Promise<void> {
    // A running reply joins the transcript when it ends, so it must end before saving.
    // Waiting messages belong to this chat, so they go first or they'd start in the new one.
    this.clearQueue();
    this.planRunning = false;
    this.abort?.abort();
    await this.turn;
    this.clearQueue();
    this.saveCurrentChat();
    // An empty chat isn't saved, so it keeps its id and any notes already written for it.
    if (chatTitle(this.transcript) !== undefined) {
      this.chatId = crypto.randomUUID();
    }
    this.contextUse = undefined;
    this.activePlan = undefined;
    this.chatKey += 1;
    this.transcript = [];
    this.pinned = [];
    this.hiddenOpenFile = undefined;
    this.journals.clear();
    this.summary = undefined;
    await this.context.workspaceState.update(CHATS_KEY, this.chats);
    await this.persist();
    this.postState();
  }

  private async info(content: string): Promise<void> {
    this.transcript.push({ role: "info", content });
    await this.persist();
    this.postState();
  }

  async send(text: string, images: AttachedImage[] = []): Promise<void> {
    const trimmed = text.trim() || (images.length ? "Describe this image." : "");
    if (!trimmed || this.busy) {
      return;
    }

    const skills = this.service.commandSkills();
    let shown = trimmed;
    let command = parseSlash(shown, skills);
    while (command.kind === "mode") {
      await this.setMode(command.mode);
      if (!command.prompt) {
        return;
      }
      shown = command.prompt;
      command = parseSlash(shown, skills);
    }
    if (command.kind === "help") {
      await this.info(this.service.helpText());
      return;
    }
    if (command.kind === "refresh") {
      const count = this.service.skills().length;
      await this.info(`Loaded ${count} skill${count === 1 ? "" : "s"}.`);
      return;
    }
    if (command.kind === "clear") {
      await this.clear();
      return;
    }
    if (command.kind === "unknown") {
      await this.info(this.service.unknownCommandText(command.name));
      return;
    }

    const skill: Skill | undefined = command.kind === "skill" ? command.skill : undefined;
    const prompt = command.kind === "skill" ? command.prompt || `Apply the ${command.skill.title} skill.` : shown;
    await this.startTurn(prompt, shown, skill, images);
  }

  /** Tracks the turn, so New Chat can wait for it to end. */
  private startTurn(prompt: string, shown: string, skill: Skill | undefined, images: AttachedImage[] = []): Promise<void> {
    const turn = this.runTurn(prompt, shown, skill, images).finally(() => {
      if (this.turn === turn) {
        this.turn = undefined;
      }
      this.startQueue();
    });
    this.turn = turn;
    return turn;
  }

  /** A plan that's in the system prompt is left out here, or it would be sent twice. */
  private historyBetween(start: number, end: number, pinnedPlan?: string): HistoryEntry[] {
    return this.transcript.flatMap((entry, index) =>
      index >= start && index < end && (entry.role === "user" || entry.role === "assistant") && !entry.error && entry.content && (!pinnedPlan || entry.planId !== pinnedPlan)
        ? [{ index, message: { role: entry.role, content: `${entry.content}${entry.context ?? ""}` } }]
        : [],
    );
  }

  private planEntry(planId: string): TranscriptEntry | undefined {
    return this.transcript.find((entry) => entry.planId === planId);
  }

  /** The saved file, with any edits, or the reply itself if the file has gone. */
  private async planText(planId: string): Promise<string | undefined> {
    return (await this.contextFiles.readPlan(this.chatId, planId)) ?? this.planEntry(planId)?.content;
  }

  private async savePlan(entry: TranscriptEntry): Promise<void> {
    if (!isPlan(entry.content)) {
      return;
    }
    entry.planId = crypto.randomUUID();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    entry.planHashes = root ? await hashPlanFiles(entry.content, root) : undefined;
    await this.contextFiles.writePlan(this.chatId, entry.planId, entry.content).catch((error: unknown) => this.log.warn(`Could not save the plan: ${String(error)}`));
    if (openQuestions(entry.content).length) {
      const text = "This plan has open questions. Answer them here for a new plan, or edit this one and set Open questions to None.";
      entry.notices?.push(text);
      this.post({ type: "notice", text });
    }
  }

  /** What the user should know before a plan runs. Read at the last moment, so edits to the plan count. */
  private async planWarnings(plan: string, entry: TranscriptEntry): Promise<string[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const changed = root && entry.planHashes ? await changedPlanFiles(entry.planHashes, root) : [];
    const questions = openQuestions(plan);
    return [
      ...(questions.length ? [`It still has open questions: ${questions.join(" ")}`] : []),
      ...(changed.length ? [`These files have changed since it was written: ${changed.join(", ")}.`] : []),
    ];
  }

  /** Takes an id from the panel, so it only uses ids this chat really has. */
  private async implementPlan(planId: string): Promise<void> {
    const entry = this.planEntry(planId);
    const plan = this.busy || !entry ? undefined : await this.planText(planId);
    if (!entry || !plan?.trim()) {
      return;
    }
    const warnings = await this.planWarnings(plan, entry);
    if (warnings.length) {
      const proceed = "Implement Anyway";
      const choice = await vscode.window.showWarningMessage("This plan may not be ready.", { modal: true, detail: warnings.join("\n\n") }, proceed);
      if (choice !== proceed || this.busy) {
        return;
      }
    }
    // Selecting a plan that's part done picks it up, because repeating finished steps could undo them.
    const resumed = this.activePlan?.id === planId ? this.activePlan : undefined;
    this.activePlan = { id: planId, title: planTitle(plan), steps: planSteps(plan), done: resumed?.done ?? 0, started: resumed?.started };
    await this.persist();
    await this.runPlan();
  }

  /**
   * Runs the active plan one turn per step. The extension does this rather than the
   * model because models report success anyway, and each step gets its own tool
   * rounds and can summarise what came before, which suits a small context window.
   */
  private async runPlan(): Promise<void> {
    if (this.busy || !this.activePlan) {
      return;
    }
    const chat = this.chatKey;
    this.planRunning = true;
    await this.setMode("agent");
    try {
      while (this.planRunning && this.activePlan && this.chatKey === chat) {
        const text = await this.planText(this.activePlan.id);
        if (!text?.trim()) {
          this.activePlan = undefined;
          await this.info("The plan has gone, so it was stopped.");
          return;
        }
        const steps = planSteps(text);
        const { done, started }: ActivePlan = this.activePlan;
        if (done >= steps.length) {
          this.activePlan = undefined;
          await this.info(`Plan finished: all ${steps.length} step${steps.length === 1 ? "" : "s"} ran, and no failures were left.`);
          return;
        }
        if (this.mode !== "agent") {
          await this.info(`Paused at step ${done + 1} of ${steps.length}, because the mode changed. Select Continue to carry on.`);
          return;
        }
        this.activePlan = { ...this.activePlan, steps, started: done };
        this.turnProblem = undefined;
        this.postState();
        const again = started === done ? " This step wasn't finished last time, so check what's already done first." : "";
        await this.startTurn(
          `Do step ${done + 1} of ${steps.length} of the approved plan, and only this step:\n${steps[done]}\n\nCheck it worked as the plan says, then say what you did.${again}`,
          `Step ${done + 1} of ${steps.length}: ${steps[done].split("\n")[0].slice(0, MAX_STEP_LABEL_CHARS)}`,
          undefined,
        );
        if (this.chatKey !== chat || !this.activePlan) {
          return;
        }
        if (this.turnProblem) {
          await this.info(`Paused at step ${done + 1} of ${steps.length}. ${this.turnProblem} Answer in the chat if it needs you, then select Continue.`);
          this.holdQueue = true;
          return;
        }
        this.activePlan = { ...this.activePlan, done: done + 1 };
        await this.persist();
      }
    } finally {
      this.planRunning = false;
      this.postState();
      this.startQueue();
    }
  }

  async openPlan(planId: string): Promise<void> {
    const entry = this.planEntry(planId);
    if (!entry) {
      return;
    }
    try {
      if ((await this.contextFiles.readPlan(this.chatId, planId)) === undefined) {
        await this.contextFiles.writePlan(this.chatId, planId, entry.content);
      }
      await vscode.window.showTextDocument(vscode.Uri.file(this.contextFiles.planFile(this.chatId, planId)));
    } catch (error) {
      this.log.warn(`Could not open the plan: ${String(error)}`);
      void vscode.window.showErrorMessage("Could not open the plan. Astute Code: Show Logs has the details.");
    }
  }

  private get busy(): boolean {
    // The turn also counts, as a turn is running before its reply has begun and after it has ended.
    return !!this.active || !!this.turn || this.updatingContext || this.planRunning;
  }

  /** Facts about a reply are worth keeping, but never worth stopping the chat for. */
  private async noteActivity(line: string | undefined): Promise<void> {
    if (line) {
      await this.contextFiles.addActivity(this.chatId, line).catch((error: unknown) => this.log.warn(`Could not update the chat context file: ${String(error)}`));
    }
  }

  /** Reads the context file each turn, so hand edits count. A file that's gone brings the older messages back. */
  private async loadContext(): Promise<ChatContext> {
    const legacy = this.summary?.text;
    if (this.summary && legacy) {
      this.summary = { upTo: this.summary.upTo };
      try {
        return await this.contextFiles.update(this.chatId, (context) => ({ ...context, summary: legacy }));
      } catch (error) {
        this.log.warn(`Could not move the summary to a file: ${String(error)}`);
        return { ...EMPTY_CONTEXT, summary: legacy };
      }
    }
    const context = (await this.contextFiles.read(this.chatId)) ?? EMPTY_CONTEXT;
    if (!context.summary) {
      this.summary = undefined;
    }
    return context;
  }

  /** Replaces older turns with a summary. If that fails it returns undefined, and the turns stay in the history. */
  private async summariseMessages(entries: HistoryEntry[], count: number, earlier: string, target: SummaryTarget, signal: AbortSignal): Promise<ChatContext | undefined> {
    // The transcript position just after the last summarised message.
    const keepFrom = count ? entries[count - 1].index + 1 : (this.summary?.upTo ?? 0);
    const limit = summaryTokens(target.usableLimit);
    const text = await this.service.summarise(entries.slice(0, count || entries.length).map((entry) => entry.message), capText(earlier, limit) || undefined, target, signal);
    const summary = text ? cleanSummary(text, limit) : "";
    if (!summary || signal.aborted) {
      return undefined;
    }
    try {
      const context = await this.contextFiles.update(this.chatId, (current) => ({ ...current, summary }));
      this.summary = { upTo: keepFrom };
      this.log.info(`Summarised the chat up to entry ${keepFrom} in ${this.contextFiles.file(this.chatId)}.`);
      return context;
    } catch (error) {
      this.log.warn(`Could not write the chat context file: ${String(error)}`);
      return undefined;
    }
  }

  private contextSections(context: ChatContext, usableLimit: number, plan?: string): { systemSection?: string; requestNote: string } {
    const sections = [plan, context.summary && summarySection(capText(context.summary, summaryTokens(usableLimit))), context.notes && notesSection(capText(context.notes, notesTokens(usableLimit)))];
    return { systemSection: sections.filter(Boolean).join("\n\n") || undefined, requestNote: recentWorkNote(recentActivity(context)) };
  }

  /** Summarises older turns before they're lost to the context limit, then picks what this turn sends. */
  private async prepareHistory(end: number, mode: ChatMode, onNotice: (text: string) => void, signal: AbortSignal, budget: HistoryBudget): Promise<PreparedHistory> {
    let context = await this.loadContext();
    const plan = mode === "agent" ? await this.pinnedPlan(budget.usableLimit, onNotice) : undefined;
    const pinned = plan === undefined ? undefined : this.activePlan?.id;
    const start = this.summary?.upTo ?? 0;
    const entries = this.historyBetween(start, end, pinned);
    const { systemSection, requestNote } = this.contextSections(context, budget.usableLimit, plan);
    const reserved = budget.reservedTokens + estimateTokens(systemSection ?? "") + estimateTokens(requestNote);
    const count = messagesToSummarise(entries.map((entry) => entry.message), budget.usableLimit, reserved);
    if (count) {
      this.status = "Summarising earlier chat…";
      this.post({ type: "status", text: this.status });
      context = (await this.summariseMessages(entries, count, context.summary, budget, signal)) ?? context;
    }
    return { history: this.historyBetween(this.summary?.upTo ?? 0, end, pinned).map((entry) => entry.message), ...this.contextSections(context, budget.usableLimit, plan) };
  }

  /** The active plan as a system prompt section. A plan cut short is worth saying so, because its last steps are missing. */
  private async pinnedPlan(usableLimit: number, onNotice: (text: string) => void): Promise<string | undefined> {
    const text = this.activePlan && (await this.planText(this.activePlan.id));
    if (!text?.trim()) {
      return undefined;
    }
    const limit = planTokens(usableLimit);
    if (estimateTokens(text) > limit) {
      onNotice("The plan is too long for the context window, so the model can't see all of it. Shorten it with Edit plan, or increase astuteChat.numCtx.");
    }
    return planSection(capText(text, limit));
  }

  /** Opens the file for reading or editing, creating it so notes can be written before the first message. */
  async openContext(): Promise<void> {
    try {
      await this.loadContext();
      // Rewriting a file that exists could clash with unsaved edits to it.
      if (!(await this.contextFiles.read(this.chatId))) {
        await this.contextFiles.update(this.chatId, (context) => context);
      }
      await this.persist();
      await vscode.window.showTextDocument(vscode.Uri.file(this.contextFiles.file(this.chatId)));
    } catch (error) {
      this.log.warn(`Could not open the chat context file: ${String(error)}`);
      void vscode.window.showErrorMessage("Could not open the chat context file. Astute Code: Show Logs has the details.");
    }
  }

  /** Brings the context file up to date on request, leaving the latest messages for the next reply. */
  async updateContext(): Promise<void> {
    if (this.busy) {
      void vscode.window.showInformationMessage("Wait for the current reply to finish, then update the chat context.");
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    this.updatingContext = true;
    const update = vscode.window
      .withProgress({ location: vscode.ProgressLocation.Notification, title: "Updating chat context…", cancellable: true }, async (_progress, token) => {
        token.onCancellationRequested(() => abort.abort());
        const context = await this.loadContext();
        const start = this.summary?.upTo ?? 0;
        const end = this.transcript.length;
        const entries = this.historyBetween(start, end);
        if (!entries.length) {
          return "There's nothing new to add to the chat context.";
        }
        const target = await this.service.summaryTarget(this.mode);
        const updated = await this.summariseMessages(entries, messagesBeforeRecent(entries.map((entry) => entry.message)), context.summary, target, abort.signal);
        return updated ? "Updated the chat context." : abort.signal.aborted ? undefined : "Could not update the chat context. Astute Code: Show Logs has the details.";
      })
      .then(
        (message) => message,
        (error: unknown) => (error instanceof Error ? error.message : "Could not update the chat context."),
      )
      .then(async (message) => {
        this.updatingContext = false;
        this.abort = undefined;
        await this.persist();
        if (message) {
          void vscode.window.showInformationMessage(message);
        }
      });
    this.turn = Promise.resolve(update).finally(() => {
      this.turn = undefined;
      this.startQueue();
    });
    await this.turn;
  }

  private async runTurn(prompt: string, shown: string, skill: Skill | undefined, images: AttachedImage[] = []): Promise<void> {
    // Set before the first await, so New Chat can always stop this turn.
    const abort = new AbortController();
    this.abort = abort;
    const selection = selectionContext();
    // Selected code already says what the request is about, so the whole file isn't added too.
    const requestContext = await buildRequestContext(selection ? undefined : this.includedOpenFile(), this.pinned);

    const user: TranscriptEntry = {
      role: "user",
      content: shown,
      context: selection?.context,
      note: selection?.note,
      images: images.length ? images.map(({ name, thumb }) => ({ name, thumb })) : undefined,
    };
    this.transcript.push(user);
    const mode = this.mode;
    const active: TranscriptEntry = { role: "assistant", content: "", thinking: "", tools: [], notices: [], mode };
    this.active = active;
    this.post({ type: "begin", user });
    this.chatsChanged.fire();
    let allowEditsThisTurn = false;
    let denied = false;
    const journal = new ChangeJournal();
    const review = this.reviewMode && MODES[mode].canChange ? await this.beginReview(prompt, active) : undefined;
    // The new message is already in the transcript, so history stops just before it.
    const end = this.transcript.length - 1;

    try {
      const result = await this.service.runTurn({
        prompt: `${prompt}${selection?.context ?? ""}${requestContext}`,
        prepareHistory: (budget) =>
          this.prepareHistory(
            end,
            mode,
            (text) => {
              active.notices?.push(text);
              this.post({ type: "notice", text });
            },
            abort.signal,
            budget,
          ),
        mode,
        skill,
        images: images.map(({ name, data }) => ({ name, data })),
        signal: abort.signal,
        takeGuidance: () => {
          const guidance = this.queue.filter((item) => item.guide);
          this.queue = this.queue.filter((item) => !item.guide);
          for (const { text } of guidance) {
            const notice = `You added: ${text}`;
            active.notices?.push(notice);
            this.post({ type: "notice", text: notice });
            // Kept with the request, so later replies know what changed.
            user.context = `${user.context ?? ""}\n\nThe user added this while the reply ran: ${text}`;
          }
          if (guidance.length) {
            this.postQueue();
          }
          return guidance.map((item) => item.text);
        },
        journal,
        confirm: async (request) => {
          const result = decide(this.approval, request, getChatSettings().allowedCommands);
          if (result.allow || (request.kind === "edit" && allowEditsThisTurn && !result.reason)) {
            const text = `Auto-approved: ${request.title.replace(/\?$/, "")}`;
            this.log.info(request.command ? `${text}: ${request.command}` : text);
            // Tool calls already show what happened, so full Auto adds no extra lines.
            if (this.approval !== "full") {
              active.notices?.push(text);
              this.post({ type: "notice", text });
            }
            return true;
          }
          const decision = await this.requestApproval(request, result.reason, abort.signal);
          allowEditsThisTurn = allowEditsThisTurn || decision === "allowEditsThisTurn";
          denied = denied || decision === "deny";
          return decision !== "deny";
        },
        events: {
          onStatus: (text) => {
            this.status = this.pending ? "Waiting for your approval…" : text;
            this.post({ type: "status", text: this.status });
          },
          onContentReset: () => {
            active.content = "";
            this.post({ type: "resetContent" });
          },
          onContext: (percent) => {
            this.contextUse = percent;
            this.post({ type: "contextUse", percent });
          },
          onThinking: (text) => {
            active.thinking += text;
            this.post({ type: "delta", kind: "thinking", text });
          },
          onContent: (text) => {
            active.content += text;
            this.post({ type: "delta", kind: "content", text });
          },
          onTool: (text) => {
            active.tools?.push(text);
            this.post({ type: "tool", text });
          },
          onNotice: (text) => {
            active.notices?.push(text);
            this.post({ type: "notice", text });
          },
        },
      });
      // Keeps what the images showed, so follow-up questions can use it.
      user.context = `${user.context ?? ""}${result.imageText}` || undefined;
      active.summary = `${MODES[mode].label} · ${result.model} · ${result.summary}`;
      if (mode === "plan" && !result.cancelled && active.content.trim()) {
        await this.savePlan(active);
      }
      this.turnProblem = stepProblem({ ...result, denied, reply: active.content });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      // What's waiting may depend on this reply, so the user decides whether it still makes sense.
      this.holdQueue = true;
      this.log.error(`Chat failed: ${error instanceof OllamaError ? error.kind : "unknown"}: ${message}`);
      active.error = true;
      this.turnProblem = stepProblem({ failure: message, reply: "" });
      active.content = active.content ? `${active.content}\n\n${message}` : message;
      if (error instanceof OllamaError && error.kind === "connection") {
        void this.monitor.refresh();
      }
    } finally {
      if (MODES[mode].canChange) {
        active.changes = journal.report();
        this.log.info(`Change report: ${JSON.stringify(active.changes)}`);
      }
      const reviewed = review ? await this.finishReview(review, prompt, [...journal.report().created, ...journal.report().edited], active) : false;
      // A review branch already keeps this work apart, and Discard removes it.
      if (journal.hasFileChanges && !reviewed) {
        active.undoId = this.nextUndoId++;
        this.journals.set(active.undoId, journal);
      }
      await this.noteActivity(activityLine(active.changes, active.tools ?? []));
      this.active = undefined;
      this.status = undefined;
      this.abort = undefined;
      // A new chat started during this reply means the reply no longer belongs anywhere.
      const stillCurrent = this.transcript.includes(user);
      if (stillCurrent) {
        this.transcript.push(active);
      }
      await this.persist();
      if (stillCurrent) {
        this.post({ type: "end", entry: active, undoable: [...this.journals.keys()] });
      } else {
        this.postState();
      }
    }
  }
}
