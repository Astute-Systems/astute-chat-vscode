import * as crypto from "crypto";
import * as vscode from "vscode";
import { ChangeRequest, decide } from "./approvals";
import { ChangeJournal } from "./changeJournal";
import { ChatService } from "./chatService";
import { messagesToSummarise, needsSummary } from "./chatSummary";
import { getChatSettings } from "./config";
import type { ConnectionMonitor } from "./connection";
import { IMAGE_FILE } from "./contentGuard";
import { openWorkspaceFile, readDroppedImages, resolveFiles, workspacePath } from "./fileResolver";
import { buildRequestContext, OpenFile } from "./contextFiles";
import { rankFiles, withFolders } from "./filePicker";
import { ApprovalDecision, ApprovalPrompt, AttachedImage, ChatListing, FromWebview, ToWebview, TranscriptEntry, ViewState } from "./messages";
import { ApprovalLevel, ChatMode, isApprovalLevel, isChatMode, MODES } from "./modes";
import { ChatMessage, OllamaError } from "./ollamaClient";
import { isSensitivePath } from "./pathGuard";
import { findRepo } from "./repoInfo";
import { baseVersion, commitReview, currentBranch, discardReview, dropEmptyReview, latestCommit, mergeReview, ReviewBranch, reviewBlocker, reviewFiles, startReview } from "./reviewBranch";
import { parseSlash, Skill } from "./skillLoader";

const STORAGE_KEY = "astuteChat.transcript";
const MODE_KEY = "astuteChat.mode";
const APPROVAL_KEY = "astuteChat.approval";
const PROPOSED_SCHEME = "astute-proposed";
const SUMMARY_KEY = "astuteChat.summary";
const REVIEW_MODE_KEY = "astuteChat.reviewMode";
const OPEN_REVIEW_KEY = "astuteChat.openReview";
const CHATS_KEY = "astuteChat.chats";
const MAX_SAVED_CHATS = 30;
const MAX_SAVED_TOOL_CHARS = 8000;
const MAX_TITLE_CHARS = 60;
const FILE_LIST_LIFETIME_MS = 30000;
const MAX_LISTED_FILES = 3000;
const MAX_STORED_ENTRIES = 200;
const MAX_SELECTION_CHARS = 12000;

interface PendingApproval {
  prompt: ApprovalPrompt;
  request: ChangeRequest;
  settle(decision: ApprovalDecision): void;
}

interface SavedChat extends ChatListing {
  transcript: TranscriptEntry[];
  summary?: { text: string; upTo: number };
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
  private pinned: Array<{ file: string; shown: string }> = [];
  private hiddenOpenFile: string | undefined;
  private readonly journals = new Map<number, ChangeJournal>();
  private readonly proposed = new ProposedChanges();
  private nextUndoId = 1;
  private chats: SavedChat[];
  private chatKey = 0;
  private reviewMode: boolean;
  private openReview: (ReviewBranch & { root: string }) | undefined;
  private summary: { text: string; upTo: number } | undefined;
  private fileList: { items: string[]; at: number } | undefined;
  private nextApprovalId = 1;
  private active: TranscriptEntry | undefined;
  private status: string | undefined;
  private abort: AbortController | undefined;

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
    this.chats = context.workspaceState.get<SavedChat[]>(CHATS_KEY, []);
    this.reviewMode = context.workspaceState.get<boolean>(REVIEW_MODE_KEY, false);
    this.openReview = context.workspaceState.get(OPEN_REVIEW_KEY);
    const savedApproval = context.workspaceState.get<string>(APPROVAL_KEY);
    this.approval = isApprovalLevel(savedApproval) ? savedApproval : "ask";
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
<title>Astute Chat</title>
</head>
<body>
<header>
  <select id="model" aria-label="Model"></select>
  <button id="history" type="button" class="secondary icon" title="Chat history" aria-label="Chat history" aria-expanded="false">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>
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
  <div id="context" hidden></div>
  <div id="attachments" hidden></div>
  <textarea id="input" rows="3" aria-label="Message" ></textarea>
  <div class="actions">
    <select id="mode" aria-label="Mode"></select>
    <button id="approvals" type="button" class="secondary compact"></button>
    <span class="spacer"></span>
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
    await this.context.workspaceState.update(STORAGE_KEY, this.transcript);
  }

  async receive(message: FromWebview): Promise<void> {
    switch (message.type) {
      case "ready":
        this.log.info("Chat panel ready.");
        this.postState();
        break;
      case "send":
        await this.send(message.text, message.images);
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
      case "openChat":
        await this.openSavedChat(message.id);
        break;
      case "deleteChat":
        this.chats = this.chats.filter((chat) => chat.id !== message.id);
        await this.context.workspaceState.update(CHATS_KEY, this.chats);
        this.postState();
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
        if (!this.active) {
          await this.setMode("agent");
          await this.runTurn("Implement the plan above.", "Implement the plan above.", undefined);
        }
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
    await this.info(parts.join(" "));
  }

  /** The id of the approval waiting for a decision, if any. */
  get pendingApprovalId(): number | undefined {
    return this.pending?.prompt.id;
  }

  /** Uses the open terminal, or opens one in the workspace if there is none. */
  private runInTerminal(text: string): void {
    const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: "Astute Chat", cwd: vscode.workspace.workspaceFolders?.[0]?.uri });
    terminal.show(true);
    terminal.sendText(text, true);
    this.log.info(`Sent to terminal "${terminal.name}": ${text}`);
  }

  stop(): void {
    this.abort?.abort();
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

  /** Moves the current chat into the saved list, if it has anything in it. */
  private saveCurrentChat(): void {
    const first = this.transcript.find((entry) => entry.role === "user");
    if (!first) {
      return;
    }
    const title = first.content.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
    const id = Math.max(0, ...this.chats.map((chat) => chat.id)) + 1;
    this.chats.push({ id, title, updatedAt: Date.now(), transcript: this.transcript.map(compactEntry), summary: this.summary });
    this.chats = this.chats.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SAVED_CHATS);
  }

  async openSavedChat(id: number): Promise<void> {
    const chat = this.chats.find((candidate) => candidate.id === id);
    if (!chat || this.active) {
      return;
    }
    this.chats = this.chats.filter((candidate) => candidate.id !== id);
    this.saveCurrentChat();
    this.transcript = chat.transcript;
    this.summary = chat.summary;
    this.pinned = [];
    this.hiddenOpenFile = undefined;
    this.journals.clear();
    this.chatKey += 1;
    await this.context.workspaceState.update(CHATS_KEY, this.chats);
    await this.persist();
    this.postState();
  }

  async clear(): Promise<void> {
    this.abort?.abort();
    this.saveCurrentChat();
    await this.context.workspaceState.update(CHATS_KEY, this.chats);
    this.chatKey += 1;
    this.transcript = [];
    this.pinned = [];
    this.hiddenOpenFile = undefined;
    this.journals.clear();
    this.summary = undefined;
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
    if (!trimmed || this.active) {
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
    await this.runTurn(prompt, shown, skill, images);
  }

  private historyBetween(start: number, end: number): ChatMessage[] {
    return this.transcript
      .slice(start, end)
      .filter((entry) => (entry.role === "user" || entry.role === "assistant") && !entry.error && entry.content)
      .map((entry) => ({ role: entry.role as "user" | "assistant", content: `${entry.content}${entry.context ?? ""}` }));
  }

  /** Replaces older turns with a summary before they're lost to the context limit. */
  private async summariseIfNeeded(end: number, signal: AbortSignal): Promise<void> {
    const start = this.summary?.upTo ?? 0;
    const history = this.historyBetween(start, end);
    if (history.length === 0 || !needsSummary(history, await this.service.contextLimit())) {
      return;
    }
    const older = history.slice(0, messagesToSummarise(history));
    // Finds the transcript position just after the last summarised message.
    let seen = 0;
    let keepFrom = start;
    while (keepFrom < end && seen < older.length) {
      const entry = this.transcript[keepFrom];
      if ((entry.role === "user" || entry.role === "assistant") && !entry.error && entry.content) {
        seen += 1;
      }
      keepFrom += 1;
    }
    this.status = "Summarising earlier chat…";
    this.post({ type: "status", text: this.status });
    const text = await this.service.summarise(older, this.summary?.text, signal);
    if (text && !signal.aborted) {
      this.summary = { text, upTo: keepFrom };
      this.log.info(`Summarised the chat up to entry ${keepFrom}.`);
    }
  }

  private async runTurn(prompt: string, shown: string, skill: Skill | undefined, images: AttachedImage[] = []): Promise<void> {
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
    const abort = new AbortController();
    this.abort = abort;
    this.post({ type: "begin", user });
    let allowEditsThisTurn = false;
    const journal = new ChangeJournal();
    const review = this.reviewMode && MODES[mode].canChange ? await this.beginReview(prompt, active) : undefined;
    // The new message is already in the transcript, so history stops just before it.
    const end = this.transcript.length - 1;
    await this.summariseIfNeeded(end, abort.signal);
    const history = this.historyBetween(this.summary?.upTo ?? 0, end);

    try {
      const result = await this.service.runTurn({
        prompt: `${prompt}${selection?.context ?? ""}${requestContext}`,
        history,
        mode,
        skill,
        chatSummary: this.summary?.text,
        images: images.map(({ name, data }) => ({ name, data })),
        signal: abort.signal,
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
          return decision !== "deny";
        },
        events: {
          onStatus: (text) => {
            this.status = this.pending ? "Waiting for your approval…" : text;
            this.post({ type: "status", text: this.status });
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      this.log.error(`Chat failed: ${error instanceof OllamaError ? error.kind : "unknown"}: ${message}`);
      active.error = true;
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
