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
}

export type ToWebview =
  | { type: "state"; state: ViewState }
  | { type: "begin"; user: TranscriptEntry }
  | { type: "delta"; kind: "thinking" | "content"; text: string }
  | { type: "status"; text: string }
  | { type: "tool"; text: string }
  | { type: "notice"; text: string }
  | { type: "approval"; prompt: ApprovalPrompt }
  | { type: "filesResolved"; id: number; files: Record<string, string> }
  | { type: "fileMatches"; id: number; items: string[] }
  | { type: "droppedImages"; images: Array<{ name: string; dataUrl: string }>; errors: string[] }
  | { type: "approvalDone"; id: number }
  | { type: "end"; entry: TranscriptEntry; undoable: number[] };

export type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string; images?: AttachedImage[] }
  | { type: "stop" }
  | { type: "selectModel"; model: string }
  | { type: "selectMode"; mode: ChatMode }
  | { type: "implementPlan" }
  | { type: "newChat" }
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
