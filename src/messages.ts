import type { ApprovalLevel, ChatMode } from "./modes";

export interface ChangeReport {
  created: string[];
  edited: string[];
  commands: number;
  failedCommands: number;
}

export interface ReviewSummary {
  branch: string;
  base: string;
  commit: string;
  files: string[];
  state: "open" | "merged" | "discarded";
}

export interface AttachedImage {
  name: string;
  /** Base64 image data, sent to the model and never stored. */
  data: string;
  /** A small data URL shown in the chat. */
  thumb: string;
}

export interface TranscriptEntry {
  images?: Array<{ name: string; thumb: string }>;
  role: "user" | "assistant" | "info";
  content: string;
  /** Extra context sent to the model but not shown, such as selected code. */
  context?: string;
  note?: string;
  thinking?: string;
  tools?: string[];
  notices?: string[];
  summary?: string;
  error?: boolean;
  mode?: ChatMode;
  /** What the tools really did, not what the model said. */
  changes?: ChangeReport;
  /** Set while this reply can still be undone. */
  undoId?: number;
  /** Names the file holding this plan. Only finished Plan replies have one. */
  planId?: string;
  /** The planned files as they were when the plan was written, or null if they didn't exist. */
  planHashes?: Record<string, string | null>;
  review?: ReviewSummary;
}

export interface ApprovalPrompt {
  id: number;
  kind: "edit" | "command" | "tool";
  title: string;
  detail: string;
  reason?: string;
  canDiff?: boolean;
}

export type ApprovalDecision = "allow" | "allowEditsThisTurn" | "deny";

/** A message waiting for the running reply. Held in memory only, like attached images. */
export interface QueuedMessage {
  id: number;
  text: string;
  /** Goes into the running reply at its next step. Commands and images need a request of their own. */
  guide: boolean;
  images?: AttachedImage[];
}

export interface ChatListing {
  id: number;
  title: string;
  updatedAt: number;
}

export interface ViewState {
  /** Changes when a different chat is opened. */
  chatKey: number;
  chats: ChatListing[];
  connection: "checking" | "connected" | "offline";
  connectionMessage: string;
  server: string;
  insecureRemote: boolean;
  models: string[];
  /** What each model can do, such as tools, vision and thinking. */
  abilities: Record<string, string[]>;
  /** Replies that can still be undone. */
  undoable: number[];
  model: string;
  mode: ChatMode;
  approval: ApprovalLevel;
  reviewMode: boolean;
  pendingApproval?: ApprovalPrompt;
  busy: boolean;
  transcript: TranscriptEntry[];
  active?: TranscriptEntry;
  /** The open file, unless the user removed it from this chat. */
  openFile?: string;
  /** Files and folders added to the chat. */
  pinned: string[];
  status?: string;
  /** Share of the context window the latest reply used. Unknown until a reply in this chat. */
  contextUse?: number;
  /** The plan Agent is following. */
  activePlan?: ActivePlan;
  /** Steps are running now, so the plan can't be continued yet. */
  planRunning: boolean;
  queued: Array<Omit<QueuedMessage, "images">>;
}

export interface ActivePlan {
  id: string;
  title: string;
  /** What to do, in order. */
  steps: string[];
  /** How many steps have finished. Steps run in order, so a count is enough. */
  done: number;
  /** The step last started, so a step that's tried again can be told so. */
  started?: number;
}

export type ToWebview =
  | { type: "state"; state: ViewState }
  | { type: "begin"; user: TranscriptEntry }
  | { type: "delta"; kind: "thinking" | "content"; text: string }
  | { type: "status"; text: string }
  | { type: "contextUse"; percent: number }
  | { type: "resetContent" }
  | { type: "tool"; text: string }
  | { type: "notice"; text: string }
  | { type: "approval"; prompt: ApprovalPrompt }
  | { type: "filesResolved"; id: number; files: Record<string, string> }
  | { type: "fileMatches"; id: number; items: string[] }
  | { type: "droppedImages"; images: Array<{ name: string; dataUrl: string }>; errors: string[] }
  | { type: "approvalDone"; id: number }
  | { type: "queue"; items: Array<Omit<QueuedMessage, "images">> }
  | { type: "restoreDraft"; text: string; images: AttachedImage[] }
  | { type: "end"; entry: TranscriptEntry; undoable: number[] };

export type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string; images?: AttachedImage[] }
  | { type: "removeQueued"; id: number }
  | { type: "stop" }
  | { type: "selectModel"; model: string }
  | { type: "selectMode"; mode: ChatMode }
  | { type: "implementPlan"; planId: string }
  | { type: "openPlan"; planId: string }
  | { type: "clearPlan" }
  | { type: "continuePlan" }
  | { type: "newChat" }
  | { type: "openContext" }
  | { type: "toggleReview" }
  | { type: "reviewAction"; branch: string; action: "diff" | "merge" | "discard" }
  | { type: "openChat"; id: number }
  | { type: "deleteChat"; id: number }
  | { type: "searchFiles"; id: number; query: string }
  | { type: "addContextPath"; item: string }
  | { type: "showDiff"; id: number }
  | { type: "undoTurn"; id: number }
  | { type: "removeContext"; item: string }
  | { type: "copyText"; text: string }
  | { type: "attachDropped"; uris: string[] }
  | { type: "resolveFiles"; id: number; references: string[] }
  | { type: "openFile"; file: string; line?: number; column?: number }
  | { type: "runInTerminal"; text: string }
  | { type: "selectApproval"; level: ApprovalLevel }
  | { type: "approvalDecision"; id: number; decision: ApprovalDecision }
  | { type: "setServer" }
  | { type: "retry" };
