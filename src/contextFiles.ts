import * as fs from "fs/promises";
import * as path from "path";
import { IMAGE_FILE } from "./contentGuard";
import { isSensitivePath } from "./pathGuard";

const MAX_FILE_CHARS = 6000;
const MAX_TOTAL_CHARS = 10000;
const MAX_FOLDER_ENTRIES = 120;
const MAX_FOLDER_DEPTH = 3;
const SKIPPED_FOLDERS = new Set(["node_modules", ".git", "out", "dist", "build", "target", "__pycache__", ".venv", "venv", ".vscode-test"]);

export interface OpenFile {
  /** Path relative to the workspace. */
  file: string;
  language: string;
  text: string;
}

export function formatFile(heading: string, file: OpenFile): string {
  const shortened = file.text.length > MAX_FILE_CHARS;
  const text = shortened ? `${file.text.slice(0, MAX_FILE_CHARS)}\n[The rest is not shown. Use read_file to see it.]` : file.text;
  return `\n\n${heading} ${file.file}:\n\`\`\`${file.language}\n${text}\n\`\`\``;
}

/** Lists a folder as indented names, so the model sees its layout without its contents. */
export async function listFolder(folder: string): Promise<string[]> {
  const lines: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= MAX_FOLDER_ENTRIES) {
        return;
      }
      const full = path.join(directory, entry.name);
      if (isSensitivePath(full) || SKIPPED_FOLDERS.has(entry.name)) {
        continue;
      }
      lines.push(`${"  ".repeat(depth)}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory() && depth + 1 < MAX_FOLDER_DEPTH) {
        await walk(full, depth + 1);
      }
    }
  };
  await walk(folder, 0);
  return lines;
}

async function pinnedText(file: string, shown: string): Promise<string> {
  const stat = await fs.stat(file).catch(() => undefined);
  if (stat?.isDirectory()) {
    const lines = await listFolder(file);
    return `\n\nThe user selected the folder ${shown}/. Apply this request to that folder, and put any new files there unless told otherwise. It contains:\n${lines.join("\n") || "(empty)"}`;
  }
  if (!stat?.isFile() || isSensitivePath(file) || IMAGE_FILE.test(file)) {
    return "";
  }
  const text = await fs.readFile(file, "utf8").catch(() => "");
  if (!text || text.includes("\0")) {
    return text ? `\n\nThe user selected ${shown}, which is a binary file.` : "";
  }
  return formatFile("The user selected", { file: shown, language: path.extname(file).slice(1), text });
}

/** Builds the text added to a request. It's sent once and is not stored in the chat. */
export async function buildRequestContext(open: OpenFile | undefined, pinned: ReadonlyArray<{ file: string; shown: string }>): Promise<string> {
  let context = "";
  if (open && !isSensitivePath(open.file) && !pinned.some((item) => item.shown === open.file)) {
    context += formatFile('The user has this file open, so "this file", "here" and similar words mean it:', open);
  }
  for (const item of pinned) {
    context += await pinnedText(item.file, item.shown);
  }
  return context.length > MAX_TOTAL_CHARS ? `${context.slice(0, MAX_TOTAL_CHARS)}\n[Context shortened. Use read_file to see more.]` : context;
}
