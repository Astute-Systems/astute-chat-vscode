import MarkdownIt from "markdown-it";
import { APPROVALS, ApprovalLevel, ChatMode, MODES } from "../src/modes";
import { findFileReferences } from "../src/fileLinks";
import { mentionAt } from "../src/filePicker";
import { describeToolCall } from "../src/toolDisplay";
import { canRunInTerminal, snippetLanguage, toTerminalCommand } from "../src/snippets";
import type { ReviewSummary, AttachedImage, ApprovalDecision, ApprovalPrompt, FromWebview, ToWebview, TranscriptEntry, ViewState } from "../src/messages";

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };

const vscode = acquireVsCodeApi();
// Model output is untrusted. Raw HTML stays disabled, and images are left out
// so a reply cannot make the view load a remote URL.
const markdown = new MarkdownIt({ html: false, linkify: true });
markdown.disable("image");

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const messages = element<HTMLElement>("messages");
const modelSelect = element<HTMLSelectElement>("model");
const modeSelect = element<HTMLSelectElement>("mode");
const newChatButton = element<HTMLButtonElement>("new-chat");
const historyButton = element<HTMLButtonElement>("history");
const historyList = element<HTMLElement>("history-list");
const banner = element<HTMLElement>("banner");
const approvalsButton = element<HTMLButtonElement>("approvals");
const reviewToggle = element<HTMLButtonElement>("review-mode");
const fullAutoButton = element<HTMLButtonElement>("full-auto");
const approvalCard = element<HTMLElement>("approval");
const statusRow = element<HTMLElement>("status");
const statusText = element<HTMLElement>("status-text");
const contextUse = element<HTMLElement>("context-use");
const contextButton = element<HTMLButtonElement>("chat-context");
const input = element<HTMLTextAreaElement>("input");
const form = element<HTMLFormElement>("composer");
const dropzone = element<HTMLElement>("dropzone");
const contextRow = element<HTMLElement>("context");
const picker = element<HTMLElement>("picker");
const attachments = element<HTMLElement>("attachments");
const sendButton = element<HTMLButtonElement>("send");
const stopButton = element<HTMLButtonElement>("stop");

interface ActiveView {
  entry: TranscriptEntry;
  root: HTMLElement;
  body: HTMLElement;
  thinkingBody: HTMLElement;
  thinking: HTMLDetailsElement;
  meta: HTMLElement;
}

let active: ActiveView | undefined;
let currentMode: ChatMode = "ask";
let approvalLevel: ApprovalLevel = "ask";
let levelBeforeFullAuto: ApprovalLevel = "ask";
let shownApproval: number | undefined;
let undoable = new Set<number>();
let pickerItems: string[] = [];
let pickerIndex = 0;
let pickerRequest = 0;
let attached: AttachedImage[] = [];
let attachmentError = "";
let nextLinkRequest = 1;
const linkRequests = new Map<number, HTMLElement>();
let renderQueued = false;

function nearBottom(): boolean {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
}

function create(tag: string, className: string, parent: HTMLElement, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  parent.appendChild(node);
  return node;
}

function snippetButton(parent: HTMLElement, label: string, title: string, done: string, action: () => void): void {
  const button = create("button", "secondary snippet-action", parent, label);
  button.title = title;
  button.setAttribute("type", "button");
  button.addEventListener("click", () => {
    action();
    button.textContent = done;
    setTimeout(() => (button.textContent = label), 1500);
  });
}

/** Adds Copy to every code block. Run waits for the finished reply, so a half-streamed command can't run. */
function addSnippetActions(body: HTMLElement, finished: boolean): void {
  for (const pre of Array.from(body.querySelectorAll("pre"))) {
    const code = pre.querySelector("code");
    const text = (code ?? pre).textContent ?? "";
    const language = snippetLanguage(code?.className ?? "");
    const snippet = document.createElement("div");
    snippet.className = "snippet";
    pre.replaceWith(snippet);
    const actions = create("div", "snippet-actions", snippet);
    snippetButton(actions, "Copy", "Copy this code", "Copied", () => vscode.postMessage({ type: "copyText", text: text.replace(/\n$/, "") }));
    if (finished && canRunInTerminal(language)) {
      snippetButton(actions, "Run", "Run in the open terminal", "Sent", () => vscode.postMessage({ type: "runInTerminal", text: toTerminalCommand(text) }));
    }
    snippet.appendChild(pre);
  }
}

function fileLink(text: string, file: string, line?: number, column?: number): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "file-link";
  link.href = "#";
  link.textContent = text;
  link.title = line ? `Open ${file}, line ${line}` : `Open ${file}`;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    vscode.postMessage({ type: "openFile", file, line, column });
  });
  return link;
}

/** Text outside code blocks and existing links, where a file name can become a link. */
function linkableTextNodes(body: HTMLElement): Text[] {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest("pre, a, button") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode as Text);
  }
  return nodes;
}

/** Relative markdown links, such as [a.ts](src/a.ts#L4), point at workspace files. */
function relativeLinks(body: HTMLElement): HTMLAnchorElement[] {
  return Array.from(body.querySelectorAll<HTMLAnchorElement>("a[href]")).filter((link) => {
    const href = link.getAttribute("href") ?? "";
    return href && !href.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(href);
  });
}

function applyFileLinks(body: HTMLElement, files: Record<string, string>): void {
  for (const node of linkableTextNodes(body)) {
    const text = node.textContent ?? "";
    const references = findFileReferences(text).filter((reference) => files[reference.path]);
    if (references.length === 0) {
      continue;
    }
    const fragment = document.createDocumentFragment();
    let position = 0;
    for (const reference of references) {
      fragment.append(text.slice(position, reference.start));
      fragment.append(fileLink(text.slice(reference.start, reference.end), files[reference.path], reference.line, reference.column));
      position = reference.end;
    }
    fragment.append(text.slice(position));
    node.replaceWith(fragment);
  }

  for (const link of relativeLinks(body)) {
    const [reference] = findFileReferences(decodeURI(link.getAttribute("href") ?? ""));
    if (reference && files[reference.path]) {
      link.replaceWith(fileLink(link.textContent ?? "", files[reference.path], reference.line, reference.column));
    }
  }
}

/** Asks the extension which file names exist, so made-up paths stay as plain text. */
function linkFiles(body: HTMLElement): void {
  const references = new Set<string>();
  for (const node of linkableTextNodes(body)) {
    findFileReferences(node.textContent ?? "").forEach((reference) => references.add(reference.path));
  }
  for (const link of relativeLinks(body)) {
    findFileReferences(decodeURI(link.getAttribute("href") ?? "")).forEach((reference) => references.add(reference.path));
  }
  if (references.size) {
    const id = nextLinkRequest++;
    linkRequests.set(id, body);
    vscode.postMessage({ type: "resolveFiles", id, references: [...references] });
  }
}

/** Shows a tool call as a header and a small code window that starts at the end. */
/** Above this share the prompt is at its limit, because the rest of the window is kept for the reply. */
const CONTEXT_USE_HIGH = 75;

function showContextUse(percent: number | undefined): void {
  contextUse.hidden = percent === undefined;
  contextUse.textContent = `Context ${percent ?? 0}%`;
  contextUse.title = "How much of the context window the latest reply used. Older messages are summarised as it fills.";
  contextUse.classList.toggle("high", (percent ?? 0) >= CONTEXT_USE_HIGH);
}

function renderTasks(parent: HTMLElement, tasks: Array<{ title: string; done: boolean }>): void {
  parent.querySelector(".tasks")?.remove();
  const list = create("ul", "tasks", parent);
  for (const task of tasks) {
    const row = create("li", task.done ? "done" : "", list);
    row.textContent = `${task.done ? "[x]" : "[ ]"} ${task.title}`;
  }
}

function renderToolCall(parent: HTMLElement, call: string, finished: boolean): void {
  const tool = describeToolCall(call);
  if (tool.tasks) {
    renderTasks(parent, tool.tasks);
    return;
  }
  const root = create("div", "tool-call", parent);
  const head = create("div", "tool-head", root);
  create("span", "tool-name", head, tool.name);
  const target = create("span", "tool-target", head, tool.target);
  if (finished && tool.target) {
    linkFiles(target);
  }
  if (tool.code?.trim()) {
    const code = tool.code;
    create("span", "spacer", head);
    snippetButton(head, "Copy", "Copy this code", "Copied", () => vscode.postMessage({ type: "copyText", text: code }));
    const window = create("pre", "tool-code", root, code);
    window.scrollTop = window.scrollHeight;
  }
}

function renderReview(parent: HTMLElement, review: ReviewSummary): void {
  const box = create("div", "review", parent);
  const label = { open: "For review", merged: "Merged", discarded: "Discarded" }[review.state];
  create("div", "", box, `${label}: ${review.branch} (${review.commit}), ${review.files.length} file${review.files.length === 1 ? "" : "s"}`);
  if (review.state !== "open") {
    return;
  }
  const action = (text: string, name: "diff" | "merge" | "discard"): void => {
    const button = create("button", "secondary snippet-action", box, text);
    button.setAttribute("type", "button");
    button.addEventListener("click", () => vscode.postMessage({ type: "reviewAction", branch: review.branch, action: name }));
  };
  action("View changes", "diff");
  action(`Merge into ${review.base}`, "merge");
  action("Discard", "discard");
}

/** Lists what the tools really did, so a confident reply can't hide a failure. */
function renderChanges(parent: HTMLElement, entry: TranscriptEntry): void {
  const changes = entry.changes;
  if (!changes) {
    return;
  }
  const root = create("div", "changes", parent);
  const line = (label: string, files: string[]): void => {
    if (files.length) {
      linkFiles(create("div", "", root, `${label}: ${files.join(", ")}`));
    }
  };
  line("Created", changes.created);
  line("Edited", changes.edited);
  if (changes.commands) {
    create("div", changes.failedCommands ? "changes-failed" : "", root, `Commands: ${changes.commands} run, ${changes.failedCommands} failed`);
  }
  if (!changes.created.length && !changes.edited.length && !changes.commands) {
    create("div", "changes-failed", root, "Nothing in the workspace changed.");
  }
  if (entry.review) {
    renderReview(root, entry.review);
  }
  if (entry.undoId !== undefined && undoable.has(entry.undoId)) {
    const id = entry.undoId;
    const undo = create("button", "secondary snippet-action", root, "Undo file changes");
    undo.setAttribute("type", "button");
    undo.title = changes.commands ? "Restores the files Agent wrote. Commands can't be undone." : "Restores the files Agent wrote.";
    undo.addEventListener("click", () => {
      undo.remove();
      vscode.postMessage({ type: "undoTurn", id });
    });
  }
}

function renderMarkdown(body: HTMLElement, content: string, finished: boolean): void {
  body.innerHTML = markdown.render(content);
  addSnippetActions(body, finished);
  if (finished) {
    linkFiles(body);
  }
}

function buildAssistant(entry: TranscriptEntry): ActiveView {
  const root = create("article", `message assistant${entry.error ? " error" : ""}`, messages);
  const meta = create("div", "meta", root);
  const thinking = document.createElement("details");
  thinking.className = "thinking";
  thinking.hidden = !entry.thinking;
  thinking.appendChild(Object.assign(document.createElement("summary"), { textContent: "Thinking" }));
  const thinkingBody = create("div", "thinking-body", thinking);
  thinkingBody.textContent = entry.thinking ?? "";
  root.appendChild(thinking);
  const body = create("div", "body", root);
  renderMarkdown(body, entry.content, Boolean(entry.summary || entry.error));
  for (const text of entry.notices ?? []) {
    create("div", "chip", meta, text);
  }
  for (const call of entry.tools ?? []) {
    renderToolCall(meta, call, Boolean(entry.summary || entry.error));
  }
  if (entry.summary) {
    create("div", "summary", root, entry.summary);
  }
  if (entry.changes) {
    renderChanges(root, entry);
  }
  // Shown here rather than added to the reply, so it never goes back to the model.
  if (entry.summary && !entry.error) {
    create("div", "eol", root, "End Of Line");
  }
  const { planId } = entry;
  if (planId && !entry.error) {
    const actions = create("div", "plan-actions", root);
    const implement = create("button", "implement", actions, "Implement in Agent mode");
    implement.addEventListener("click", () => vscode.postMessage({ type: "implementPlan", planId }));
    const edit = create("button", "implement secondary", actions, "Edit plan");
    edit.addEventListener("click", () => vscode.postMessage({ type: "openPlan", planId }));
  }
  return { entry, root, body, thinkingBody, thinking, meta };
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 5;
const THUMB_SIZE = 160;

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function makeThumbnail(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, THUMB_SIZE / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.7));
    };
    image.onerror = () => reject(new Error("not an image"));
    image.src = dataUrl;
  });
}

function showAttachmentError(text: string): void {
  attachmentError = text;
  renderAttachments();
}

function renderAttachments(): void {
  attachments.replaceChildren();
  attachments.hidden = attached.length === 0 && !attachmentError;
  attached.forEach((image, index) => {
    const item = create("div", "attachment", attachments);
    item.title = image.name;
    const preview = document.createElement("img");
    preview.src = image.thumb;
    preview.alt = image.name;
    item.appendChild(preview);
    const remove = create("button", "secondary attachment-remove", item, "×");
    remove.setAttribute("type", "button");
    remove.setAttribute("aria-label", `Remove ${image.name}`);
    remove.addEventListener("click", () => {
      attached.splice(index, 1);
      renderAttachments();
    });
  });
  if (attachmentError) {
    create("div", "chip attachment-error", attachments, attachmentError);
  }
}

async function addImage(name: string, dataUrl: string): Promise<void> {
  if (attached.length >= MAX_IMAGES) {
    showAttachmentError(`You can attach up to ${MAX_IMAGES} images.`);
    return;
  }
  attached.push({ name, data: dataUrl.slice(dataUrl.indexOf(",") + 1), thumb: await makeThumbnail(dataUrl) });
  renderAttachments();
}

/** Files dragged from the VS Code Explorer arrive as URIs, not file data. */
function droppedUris(data: DataTransfer | null): string[] {
  const list = data?.getData("application/vnd.code.uri-list") || data?.getData("text/uri-list") || "";
  return list.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).some((type) => type === "Files" || type.includes("uri-list") || type === "ResourceURLs");
}

async function attachFiles(files: File[]): Promise<void> {
  attachmentError = "";
  for (const file of files) {
    if (!IMAGE_TYPES.has(file.type)) {
      showAttachmentError(`${file.name || "That file"} isn't a PNG or JPEG.`);
    } else if (file.size > MAX_IMAGE_BYTES) {
      showAttachmentError(`${file.name || "That image"} is larger than 20 MB.`);
    } else if (attached.length >= MAX_IMAGES) {
      showAttachmentError(`You can attach up to ${MAX_IMAGES} images.`);
    } else {
      try {
        await addImage(file.name || "pasted-image.png", await readDataUrl(file));
      } catch {
        showAttachmentError(`${file.name || "That image"} couldn't be read.`);
      }
    }
  }
}

function imageFiles(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []);
}

function renderEntry(entry: TranscriptEntry): void {
  if (entry.role === "assistant") {
    buildAssistant(entry);
    return;
  }
  if (entry.role === "info") {
    const root = create("article", "message info", messages);
    renderMarkdown(create("div", "body", root), entry.content, true);
    return;
  }
  const root = create("article", "message user", messages);
  linkFiles(create("div", "body plain", root, entry.content));
  if (entry.images?.length) {
    const row = create("div", "sent-images", root);
    for (const image of entry.images) {
      if (image.thumb.startsWith("data:image/")) {
        const preview = document.createElement("img");
        preview.src = image.thumb;
        preview.alt = image.name;
        preview.title = image.name;
        row.appendChild(preview);
      }
    }
  }
  if (entry.note) {
    create("div", "chip", root, entry.note);
  }
}

function renderApprovalLevel(): void {
  const current = APPROVALS.find((level) => level.id === approvalLevel) ?? APPROVALS[0];
  approvalsButton.textContent = current.label;
  approvalsButton.title = `${current.description} Select to change, or press Shift+Tab to cycle.`;
  approvalsButton.setAttribute("aria-label", `Approvals: ${current.label}. ${current.description}`);
  reviewToggle.hidden = currentMode !== "agent";
  const fullAuto = approvalLevel === "full";
  approvalsButton.hidden = currentMode !== "agent" || fullAuto;
  fullAutoButton.hidden = currentMode !== "agent";
  fullAutoButton.classList.toggle("on", fullAuto);
  fullAutoButton.setAttribute("aria-pressed", String(fullAuto));
  fullAutoButton.title = fullAuto ? "Auto is on: Agent runs everything without asking, including commands. Select to turn it off." : "Turn on Auto: Agent runs everything without asking, including commands.";
}

function toggleFullAuto(): void {
  if (approvalLevel === "full") {
    approvalLevel = levelBeforeFullAuto;
  } else {
    levelBeforeFullAuto = approvalLevel;
    approvalLevel = "full";
  }
  renderApprovalLevel();
  vscode.postMessage({ type: "selectApproval", level: approvalLevel });
}

function cycleApproval(): void {
  if (approvalLevel === "full") {
    return;
  }
  const index = APPROVALS.findIndex((level) => level.id === approvalLevel);
  approvalLevel = APPROVALS[(index + 1) % APPROVALS.length].id;
  renderApprovalLevel();
  vscode.postMessage({ type: "selectApproval", level: approvalLevel });
}

function hideApproval(): void {
  approvalCard.hidden = true;
  approvalCard.replaceChildren();
  shownApproval = undefined;
}

function showApproval(prompt: ApprovalPrompt): void {
  if (shownApproval === prompt.id) {
    return;
  }
  shownApproval = prompt.id;
  approvalCard.replaceChildren();
  approvalCard.hidden = false;
  create("h2", "", approvalCard, prompt.title);
  if (prompt.reason) {
    create("p", "reason", approvalCard, prompt.reason);
  }
  create("pre", "", approvalCard, prompt.detail);
  const buttons = create("div", "choices", approvalCard);
  const choice = (label: string, decision: ApprovalDecision, secondary: boolean): void => {
    const button = create("button", secondary ? "secondary" : "", buttons, label);
    button.addEventListener("click", () => {
      hideApproval();
      vscode.postMessage({ type: "approvalDecision", id: prompt.id, decision });
    });
  };
  if (prompt.canDiff) {
    const diff = create("button", "secondary", buttons, "View diff");
    diff.setAttribute("type", "button");
    diff.addEventListener("click", () => vscode.postMessage({ type: "showDiff", id: prompt.id }));
  }
  choice(prompt.kind === "edit" ? "Allow" : "Run", "allow", false);
  if (prompt.kind === "edit" && !prompt.reason) {
    choice("Allow all edits this turn", "allowEditsThisTurn", true);
  }
  choice("Deny", "deny", true);
  // Focus stays in the message box, so pressing Enter can never approve by accident.
}

function setBusy(busy: boolean): void {
  sendButton.hidden = busy;
  stopButton.hidden = !busy;
  stopButton.disabled = false;
  stopButton.classList.remove("stopping");
  stopButton.title = "Stop (Esc)";
  if (!busy) {
    hideApproval();
  }
  statusRow.hidden = !busy;
  if (!busy) {
    statusText.textContent = "";
  }
}

function queueRender(): void {
  if (renderQueued) {
    return;
  }
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!active) {
      return;
    }
    const stick = nearBottom();
    renderMarkdown(active.body, active.entry.content, false);
    if (stick) {
      messages.scrollTop = messages.scrollHeight;
    }
  });
}

function shortDate(time: number): string {
  return new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function renderHistory(state: ViewState): void {
  historyList.replaceChildren();
  if (state.chats.length === 0) {
    create("div", "history-empty", historyList, "No earlier chats.");
  }
  for (const chat of state.chats) {
    const row = create("div", "history-row", historyList);
    const open = create("button", "history-open", row);
    open.setAttribute("type", "button");
    open.title = chat.title;
    create("span", "history-title", open, chat.title);
    create("span", "history-date", open, shortDate(chat.updatedAt));
    open.addEventListener("click", () => {
      setHistoryOpen(false);
      vscode.postMessage({ type: "openChat", id: chat.id });
    });
    const remove = create("button", "context-remove", row, "×");
    remove.setAttribute("type", "button");
    remove.setAttribute("aria-label", `Delete ${chat.title}`);
    remove.addEventListener("click", () => vscode.postMessage({ type: "deleteChat", id: chat.id }));
  }
}

function setHistoryOpen(open: boolean): void {
  historyList.hidden = !open;
  historyButton.setAttribute("aria-expanded", String(open));
}

function renderContext(state: ViewState): void {
  const items = [...(state.openFile ? [state.openFile] : []), ...state.pinned];
  contextRow.replaceChildren();
  contextRow.hidden = items.length === 0 && !state.activePlan;
  if (state.activePlan) {
    const chip = create("div", "context-chip", contextRow);
    chip.title = "Agent keeps this plan in view. Remove it when the work is done.";
    create("span", "", chip, `Plan: ${state.activePlan.title}`);
    const remove = create("button", "context-remove", chip, "×");
    remove.setAttribute("type", "button");
    remove.setAttribute("aria-label", "Stop following the plan");
    remove.addEventListener("click", () => vscode.postMessage({ type: "clearPlan" }));
  }
  for (const item of items) {
    const chip = create("div", "context-chip", contextRow);
    chip.title = `${item} is included with your next message`;
    create("span", "", chip, item.split("/").pop() || item);
    const remove = create("button", "context-remove", chip, "×");
    remove.setAttribute("type", "button");
    remove.setAttribute("aria-label", `Remove ${item}`);
    remove.addEventListener("click", () => vscode.postMessage({ type: "removeContext", item }));
  }
}

function closePicker(): void {
  picker.hidden = true;
  pickerItems = [];
}

function renderPicker(): void {
  picker.replaceChildren();
  picker.hidden = pickerItems.length === 0;
  pickerItems.forEach((item, index) => {
    const row = create("button", `picker-item${index === pickerIndex ? " selected" : ""}`, picker, item);
    row.setAttribute("type", "button");
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      choosePickerItem(index);
    });
  });
}

function choosePickerItem(index: number): void {
  const mention = mentionAt(input.value, input.selectionStart);
  if (mention) {
    input.setRangeText("", mention.start, input.selectionStart, "end");
  }
  vscode.postMessage({ type: "addContextPath", item: pickerItems[index] });
  closePicker();
}

function updatePicker(): void {
  const mention = mentionAt(input.value, input.selectionStart);
  if (mention) {
    vscode.postMessage({ type: "searchFiles", id: ++pickerRequest, query: mention.query });
  } else {
    closePicker();
  }
}

function renderHeader(state: ViewState): void {
  renderContext(state);
  renderHistory(state);
  undoable = new Set(state.undoable);
  reviewToggle.classList.toggle("on", state.reviewMode);
  reviewToggle.setAttribute("aria-pressed", String(state.reviewMode));
  reviewToggle.title = state.reviewMode ? "Review is on: Agent works on its own branch for you to merge or discard." : "Turn on Review: Agent works on its own branch for you to merge or discard.";
  modeSelect.value = state.mode;
  currentMode = state.mode;
  approvalLevel = state.approval;
  renderApprovalLevel();
  input.placeholder = MODES[state.mode].placeholder;
  const names = [...state.models];
  if (state.model && !names.includes(state.model)) {
    names.unshift(state.model);
  }
  modelSelect.replaceChildren();
  if (!state.model) {
    modelSelect.add(new Option("Smallest local model", "", true, true));
  }
  for (const name of names) {
    const abilities = (state.abilities[name] ?? []).filter((ability) => ability === "tools" || ability === "vision" || ability === "thinking");
    const label = state.abilities[name]?.includes("cloud") ? `☁ ${name}` : name;
    modelSelect.add(new Option(abilities.length ? `${label} · ${abilities.join(" · ")}` : label, name, false, name === state.model));
  }
  modelSelect.disabled = names.length === 0;

  const lacksTools = state.mode === "agent" && Boolean(state.model) && state.abilities[state.model] !== undefined && !state.abilities[state.model].includes("tools");
  banner.replaceChildren();
  banner.hidden = state.connection !== "offline" && !state.insecureRemote && !lacksTools;
  if (state.connection === "offline") {
    banner.className = "offline";
    create("span", "", banner, `${state.connectionMessage} Retrying automatically.`);
    const retry = create("button", "link", banner, "Retry now");
    retry.addEventListener("click", () => vscode.postMessage({ type: "retry" }));
    const change = create("button", "link", banner, "Change server");
    change.addEventListener("click", () => vscode.postMessage({ type: "setServer" }));
  } else if (lacksTools) {
    banner.className = "warning";
    create("span", "", banner, `${state.model} can't use tools, so Agent mode will use another model.`);
  } else if (state.insecureRemote) {
    banner.className = "warning";
    create("span", "", banner, `Prompts and code go to ${state.server} without encryption.`);
  }
}

function renderAll(state: ViewState): void {
  renderHeader(state);
  messages.replaceChildren();
  active = undefined;
  state.transcript.forEach(renderEntry);
  if (state.active) {
    active = buildAssistant(state.active);
  }
  if (state.transcript.length === 0 && !state.active) {
    create("div", "empty", messages, "Ask about this workspace. Drag an image here to attach it.");
  }
  setBusy(state.busy);
  statusText.textContent = state.status ?? "";
  showContextUse(state.contextUse);
  if (state.pendingApproval) {
    showApproval(state.pendingApproval);
  }
  messages.scrollTop = messages.scrollHeight;
}

let lastTranscriptSize = -1;
let lastChatKey = -1;

window.addEventListener("message", (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case "state": {
      // Connection updates arrive often, so only rebuild when the chat changed.
      const changed = message.state.chatKey !== lastChatKey || message.state.transcript.length !== lastTranscriptSize || (message.state.busy && !active) || (!message.state.busy && active);
      lastTranscriptSize = message.state.transcript.length;
      lastChatKey = message.state.chatKey;
      if (changed) {
        renderAll(message.state);
      } else {
        renderHeader(message.state);
      }
      break;
    }
    case "begin":
      messages.querySelector(".empty")?.remove();
      renderEntry(message.user);
      active = buildAssistant({ role: "assistant", content: "", thinking: "" });
      lastTranscriptSize += 1;
      setBusy(true);
      messages.scrollTop = messages.scrollHeight;
      break;
    case "delta":
      if (!active) {
        break;
      }
      if (message.kind === "thinking") {
        const stick = nearBottom();
        active.thinking.hidden = false;
        active.thinkingBody.textContent += message.text;
        if (stick) {
          messages.scrollTop = messages.scrollHeight;
        }
      } else {
        active.entry.content += message.text;
        queueRender();
      }
      break;
    case "status":
      statusRow.hidden = false;
      statusText.textContent = message.text;
      break;
    case "contextUse":
      showContextUse(message.percent);
      break;
    case "tool": {
      if (active) {
        const stick = nearBottom();
        renderToolCall(active.meta, message.text, false);
        if (stick) {
          messages.scrollTop = messages.scrollHeight;
        }
      }
      break;
    }
    case "notice":
      if (active) {
        create("div", "chip", active.meta, message.text);
      }
      break;
    case "filesResolved": {
      const body = linkRequests.get(message.id);
      linkRequests.delete(message.id);
      if (body?.isConnected) {
        applyFileLinks(body, message.files);
      }
      break;
    }
    case "droppedImages":
      attachmentError = message.errors[0] ?? "";
      renderAttachments();
      for (const image of message.images) {
        void addImage(image.name, image.dataUrl);
      }
      break;
    case "fileMatches":
      if (message.id === pickerRequest) {
        pickerItems = message.items;
        pickerIndex = 0;
        renderPicker();
      }
      break;
    case "approval":
      showApproval(message.prompt);
      break;
    case "approvalDone":
      if (shownApproval === message.id) {
        hideApproval();
      }
      break;
    case "end":
      undoable = new Set(message.undoable);
      active?.root.remove();
      active = undefined;
      renderEntry(message.entry);
      lastTranscriptSize += 1;
      setBusy(false);
      messages.scrollTop = messages.scrollHeight;
      input.focus();
      break;
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if ((text || attached.length) && !active) {
    vscode.postMessage({ type: "send", text, images: attached.length ? attached : undefined });
    input.value = "";
    attached = [];
    attachmentError = "";
    renderAttachments();
  }
});

function requestStop(): void {
  if (!stopButton.hidden && !stopButton.disabled) {
    stopButton.disabled = true;
    stopButton.classList.add("stopping");
    stopButton.title = "Stopping…";
    hideApproval();
    vscode.postMessage({ type: "stop" });
  }
}

input.addEventListener("input", updatePicker);
input.addEventListener("blur", closePicker);
input.addEventListener("keydown", (event) => {
  if (!picker.hidden) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      pickerIndex = (pickerIndex + (event.key === "ArrowDown" ? 1 : pickerItems.length - 1)) % pickerItems.length;
      renderPicker();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      choosePickerItem(pickerIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePicker();
      return;
    }
  }
  if (event.key === "Tab" && event.shiftKey && currentMode === "agent") {
    event.preventDefault();
    cycleApproval();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

for (const mode of Object.values(MODES)) {
  modeSelect.add(new Option(mode.label, mode.id));
}
modeSelect.addEventListener("change", () => vscode.postMessage({ type: "selectMode", mode: modeSelect.value as ChatMode }));
stopButton.addEventListener("click", requestStop);
input.addEventListener("paste", (event) => {
  const files = imageFiles(event.clipboardData);
  if (files.length) {
    event.preventDefault();
    void attachFiles(files);
  }
});
window.addEventListener("dragover", (event) => {
  if (hasFiles(event)) {
    event.preventDefault();
    dropzone.hidden = false;
  }
});
window.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) {
    dropzone.hidden = true;
  }
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.hidden = true;
  const files = imageFiles(event.dataTransfer);
  const uris = droppedUris(event.dataTransfer);
  if (files.length) {
    void attachFiles(files);
  } else if (uris.length) {
    vscode.postMessage({ type: "attachDropped", uris });
  }
});
approvalsButton.addEventListener("click", cycleApproval);
fullAutoButton.addEventListener("click", toggleFullAuto);
reviewToggle.addEventListener("click", () => vscode.postMessage({ type: "toggleReview" }));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    requestStop();
  }
});
historyButton.addEventListener("click", () => setHistoryOpen(historyList.hidden));
contextButton.addEventListener("click", () => vscode.postMessage({ type: "openContext" }));
newChatButton.addEventListener("click", () => {
  attached = [];
  attachmentError = "";
  renderAttachments();
  input.value = "";
  vscode.postMessage({ type: "newChat" });
  input.focus();
});
modelSelect.addEventListener("change", () => vscode.postMessage({ type: "selectModel", model: modelSelect.value }));

vscode.postMessage({ type: "ready" });
