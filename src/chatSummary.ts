import { estimateMessages } from "./chatEngine";
import type { ChatMessage } from "./ollamaClient";

const SUMMARY_SHARE = 0.5;
const KEEP_RECENT_MESSAGES = 4;

export const SUMMARY_PROMPT =
  "Summarise this conversation for an assistant that will continue it. Keep decisions, file names, commands, errors and unfinished work. Use short bullet points, and leave out pleasantries.";

/** Summarise once history takes up half of the context window. */
export function needsSummary(history: readonly ChatMessage[], contextLimit: number): boolean {
  return history.length > KEEP_RECENT_MESSAGES && estimateMessages([...history]) > contextLimit * SUMMARY_SHARE;
}

/** How many messages from the start of the history should go into the summary. */
export function messagesToSummarise(history: readonly ChatMessage[]): number {
  return Math.max(0, history.length - KEEP_RECENT_MESSAGES);
}

/** Goes in the system prompt, which is never trimmed, so the summary can't be lost. */
export function summarySection(summary: string): string {
  return `Summary of the earlier conversation:\n${summary}`;
}
