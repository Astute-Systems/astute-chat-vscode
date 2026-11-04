import type { ChatListing, TranscriptEntry } from "./messages";

const MAX_TITLE_CHARS = 60;

/** One line in the Chats view. The current chat isn't saved yet, so it has no real id. */
export interface ChatRow extends ChatListing {
  current: boolean;
}

/** Names a chat after its first request. A chat with no request has nothing worth keeping. */
export function chatTitle(transcript: TranscriptEntry[]): string | undefined {
  const first = transcript.find((entry) => entry.role === "user");
  return first?.content.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
}

/** Opening a saved chat takes it off the saved list, so the current chat is listed too or it would seem to vanish. */
export function chatRows(currentTitle: string | undefined, chats: ChatListing[]): ChatRow[] {
  const current = currentTitle === undefined ? [] : [{ id: 0, title: currentTitle, updatedAt: 0, current: true }];
  return [...current, ...chats.map((chat) => ({ ...chat, current: false }))];
}
