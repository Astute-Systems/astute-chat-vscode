import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { ChangeRequest, checkCommand } from "./approvals";
import type { ChangeJournal } from "./changeJournal";
import { REFUSED, ToolRunner } from "./chatEngine";
import { chunkFile, CodeChunk, rankChunks } from "./codeSearch";
import { BUILD_OUTPUT_GLOB, checkEditContent, checkFileContent, IMAGE_FILE } from "./contentGuard";
import type { ChatMode } from "./modes";
import type { McpManager } from "./mcpManager";
import type { ToolCall, ToolDefinition } from "./ollamaClient";
import { isInside, isSensitivePath } from "./pathGuard";
import { runShell } from "./shell";
import { isToolAllowed, replaceUnique, toolsForMode } from "./toolDefinitions";

/** Returns true only when the change is approved. */
export type ConfirmChange = (request: ChangeRequest) => Promise<boolean>;

/** Looks at base64 image data and returns what it shows. */
export type ImageReader = (name: string, data: string, question: string, signal?: AbortSignal) => Promise<string>;

const MAX_RESULT_CHARS = 12000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const MAX_SEARCH_FILES = 400;
const MAX_MATCHES = 50;
const MAX_PROBLEMS = 40;
const MAX_INDEXED_FILES = 1500;
const COMMAND_TIMEOUT_MS = 120000;
const PROBE_TIMEOUT_MS = 30000;
const MAX_PREVIEW_CHARS = 1500;
const EXCLUDE = "**/{node_modules,.git,out,dist,build,.vscode-test}/**";

function folders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

function display(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri);
}

function clip(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[Output shortened]` : text;
}

async function findFile(requested: string): Promise<{ real: string; shown: string } | string> {
  for (const folder of folders()) {
    const root = await fs.realpath(folder.uri.fsPath);
    const candidate = path.resolve(root, requested);
    if (!isInside(root, candidate)) {
      continue;
    }
    try {
      const real = await fs.realpath(candidate);
      if (!isInside(root, real)) {
        return "That path is outside the workspace.";
      }
      return { real, shown: path.relative(root, real) };
    } catch {
      // Try the next workspace folder.
    }
  }
  return `File not found in the workspace: ${requested}`;
}

async function listFiles(pattern: string): Promise<string> {
  const uris = await vscode.workspace.findFiles(pattern || "**/*", EXCLUDE, 300);
  const names = uris.map(display).filter((name) => !isSensitivePath(name)).sort();
  return names.length ? clip(names.join("\n")) : "No files matched.";
}

async function readFile(requested: string, start?: number, end?: number): Promise<string> {
  const found = await findFile(requested);
  if (typeof found === "string") {
    return found;
  }
  if (isSensitivePath(found.real)) {
    return "That file may contain secrets, so it was not read.";
  }
  if (IMAGE_FILE.test(found.real)) {
    return "That file is an image. Use view_image instead.";
  }
  const stat = await fs.stat(found.real);
  if (!stat.isFile()) {
    return "That path is not a file.";
  }
  if (stat.size > MAX_FILE_BYTES) {
    return "That file is too large to read.";
  }
  const text = await fs.readFile(found.real, "utf8");
  if (text.includes("\0")) {
    return "That file is binary, so it was not read.";
  }
  const lines = text.split(/\r?\n/);
  const first = Math.max(1, start ?? 1);
  const last = Math.min(lines.length, end ?? lines.length);
  return clip(`${found.shown} lines ${first}-${last} of ${lines.length}\n${lines.slice(first - 1, last).join("\n")}`);
}

async function viewImage(requested: string, question: string, read: ImageReader | undefined, signal?: AbortSignal): Promise<string> {
  if (!read) {
    return "Images can't be viewed here.";
  }
  const found = await findFile(requested);
  if (typeof found === "string") {
    return found;
  }
  if (!IMAGE_FILE.test(found.real)) {
    return "view_image reads PNG and JPEG files only.";
  }
  const stat = await fs.stat(found.real);
  if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) {
    return "That image is too large to view.";
  }
  const description = await read(path.basename(found.real), (await fs.readFile(found.real)).toString("base64"), question, signal);
  return `${found.shown}:\n${description}`;
}

async function findCode(query: string): Promise<string> {
  const uris = await vscode.workspace.findFiles("**/*", EXCLUDE, MAX_INDEXED_FILES);
  const chunks: CodeChunk[] = [];
  for (const uri of uris) {
    try {
      if (isSensitivePath(uri.fsPath) || IMAGE_FILE.test(uri.fsPath) || (await fs.stat(uri.fsPath)).size > MAX_SEARCH_FILE_BYTES) {
        continue;
      }
      const text = await fs.readFile(uri.fsPath, "utf8");
      if (!text.includes("\0")) {
        chunks.push(...chunkFile(display(uri), text));
      }
    } catch {
      // Skip files that disappear or cannot be read.
    }
  }
  const matches = rankChunks(chunks, query);
  if (matches.length === 0) {
    return "No relevant code was found.";
  }
  return clip(matches.map((match) => `${match.file}, from line ${match.startLine}:\n${match.text}`).join("\n\n---\n\n"));
}

function describeSeverity(severity: vscode.DiagnosticSeverity): string {
  return severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
}

function getProblems(requested: string): string {
  const lines: string[] = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    const file = display(uri);
    if (uri.scheme !== "file" || path.isAbsolute(file) || (requested && !file.endsWith(requested))) {
      continue;
    }
    for (const item of diagnostics.filter((diagnostic) => diagnostic.severity <= vscode.DiagnosticSeverity.Warning)) {
      lines.push(`${describeSeverity(item.severity)} ${file}:${item.range.start.line + 1}: ${item.message}`);
    }
  }
  lines.sort((a, b) => Number(a.startsWith("warning")) - Number(b.startsWith("warning")));
  return lines.length ? clip(lines.slice(0, MAX_PROBLEMS).join("\n")) : "There are no errors or warnings in the Problems panel.";
}

async function searchText(query: string, pattern?: string): Promise<string> {
  const needle = query.toLowerCase();
  if (!needle) {
    return "Enter some text to search for.";
  }
  const uris = await vscode.workspace.findFiles(pattern || "**/*", EXCLUDE, MAX_SEARCH_FILES);
  const matches: string[] = [];

  for (const uri of uris) {
    if (matches.length >= MAX_MATCHES) {
      break;
    }
    if (isSensitivePath(uri.fsPath)) {
      continue;
    }
    try {
      if ((await fs.stat(uri.fsPath)).size > MAX_SEARCH_FILE_BYTES) {
        continue;
      }
      const text = await fs.readFile(uri.fsPath, "utf8");
      if (text.includes("\0")) {
        continue;
      }
      text.split(/\r?\n/).forEach((line, index) => {
        if (matches.length < MAX_MATCHES && line.toLowerCase().includes(needle)) {
          matches.push(`${display(uri)}:${index + 1}: ${line.trim().slice(0, 200)}`);
        }
      });
    } catch {
      // Skip files that disappear or cannot be read.
    }
  }
  return matches.length ? clip(matches.join("\n")) : "No matches found.";
}

function argumentsOf(call: ToolCall): Record<string, unknown> {
  const value: unknown = call.function.arguments;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (value as Record<string, unknown>) ?? {};
}

function preview(text: string): string {
  return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}\n[Preview shortened]` : text;
}

async function nearestExisting(target: string): Promise<string> {
  for (let current = target; ; current = path.dirname(current)) {
    try {
      return await fs.realpath(current);
    } catch {
      if (path.dirname(current) === current) {
        throw new Error("No existing parent folder.");
      }
    }
  }
}

/** Finds a safe place to write, following symlinks in the part that exists. */
async function writeTarget(requested: string): Promise<{ uri: vscode.Uri; shown: string } | string> {
  if (!requested) {
    return "A path is required.";
  }
  for (const folder of folders()) {
    const root = await fs.realpath(folder.uri.fsPath);
    const candidate = path.resolve(root, requested);
    if (!isInside(root, candidate)) {
      continue;
    }
    if (!isInside(root, await nearestExisting(candidate))) {
      return "That path is outside the workspace.";
    }
    const shown = path.relative(root, candidate);
    if (isSensitivePath(shown)) {
      return "That file may contain secrets or repository data, so it was not changed.";
    }
    return { uri: vscode.Uri.file(candidate), shown };
  }
  return "That path is outside the workspace.";
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function replaceDocument(uri: vscode.Uri, content: string): Promise<boolean> {
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), content);
  return (await vscode.workspace.applyEdit(edit)) && (await document.save());
}

async function writeFile(requested: string, content: string, confirm: ConfirmChange, journal?: ChangeJournal): Promise<string> {
  const target = await writeTarget(requested);
  if (typeof target === "string") {
    return target;
  }
  const problem = checkFileContent(target.shown, content);
  if (problem) {
    return `${REFUSED}${problem}`;
  }
  const present = await exists(target.uri);
  const before = present ? (await vscode.workspace.openTextDocument(target.uri)).getText() : null;
  if (!(await confirm({ kind: "edit", title: `${present ? "Replace" : "Create"} ${target.shown}?`, detail: preview(content), path: target.shown, existingSize: before?.length, newSize: content.length, file: target.uri.fsPath, proposed: content }))) {
    return "The user denied this change.";
  }
  if (present) {
    if (!(await replaceDocument(target.uri, content))) {
      return `Could not save ${target.shown}.`;
    }
    journal?.recordFile(target.uri.fsPath, target.shown, before, content);
    return `Replaced ${target.shown}.`;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.uri.fsPath)));
  await vscode.workspace.fs.writeFile(target.uri, Buffer.from(content, "utf8"));
  journal?.recordFile(target.uri.fsPath, target.shown, null, content);
  return `Created ${target.shown}.`;
}

async function editFile(requested: string, oldText: string, newText: string, confirm: ConfirmChange, journal?: ChangeJournal): Promise<string> {
  const target = await writeTarget(requested);
  if (typeof target === "string") {
    return target;
  }
  if (!(await exists(target.uri))) {
    return `File not found: ${target.shown}`;
  }
  const problem = checkEditContent(target.shown, newText);
  if (problem) {
    return `${REFUSED}${problem}`;
  }
  const document = await vscode.workspace.openTextDocument(target.uri);
  const result = replaceUnique(document.getText(), oldText, newText);
  if ("error" in result) {
    return result.error;
  }
  if (!(await confirm({ kind: "edit", title: `Edit ${target.shown}?`, detail: preview(`Replace:\n${oldText}\n\nWith:\n${newText}`), path: target.shown, file: target.uri.fsPath, proposed: result.text }))) {
    return "The user denied this change.";
  }
  const before = document.getText();
  if (!(await replaceDocument(target.uri, result.text))) {
    return `Could not save ${target.shown}.`;
  }
  journal?.recordFile(target.uri.fsPath, target.shown, before, result.text);
  return `Edited ${target.shown}.`;
}

/** Catches commands such as `touch libfoo.a`, which look like a build but produce nothing. */
async function emptyBuildOutputs(since: number): Promise<string[]> {
  const files = await vscode.workspace.findFiles(BUILD_OUTPUT_GLOB, EXCLUDE, 200);
  const empty: string[] = [];
  for (const uri of files) {
    const stat = await fs.stat(uri.fsPath).catch(() => undefined);
    if (stat?.size === 0 && stat.mtimeMs >= since - 1000) {
      empty.push(display(uri));
    }
  }
  return empty;
}

/** Project commands from the allowed list stay out of this, because they can change files. */
async function probeCommand(command: string, signal?: AbortSignal): Promise<string> {
  const root = folders()[0]?.uri.fsPath;
  if (!root) {
    return "An open workspace is required.";
  }
  const check = checkCommand(command);
  if (!check.safe) {
    return `That command wasn't run, because it isn't read-only: ${check.reason} In Agent mode, use run_command. Otherwise, ask the user to switch to Agent mode.`;
  }
  const result = await runShell(command, root, PROBE_TIMEOUT_MS, signal);
  return clip(`${result.timedOut ? "Timed out" : `Exit code ${String(result.exitCode)}`}\n${result.output || "(no output)"}`);
}

async function runCommand(command: string, confirm: ConfirmChange, signal?: AbortSignal, journal?: ChangeJournal): Promise<string> {
  const root = folders()[0]?.uri.fsPath;
  if (!command.trim() || !root) {
    return "A command and an open workspace are required.";
  }
  if (!(await confirm({ kind: "command", title: "Run this command?", detail: preview(command), command }))) {
    return "The user denied this command.";
  }
  const started = Date.now();
  const result = await runShell(command, root, COMMAND_TIMEOUT_MS, signal);
  const empty = await emptyBuildOutputs(started);
  journal?.recordCommand(result.exitCode === 0);
  const status = result.stopped ? "Stopped by the user" : result.timedOut ? "Timed out" : `Exit code ${String(result.exitCode)}`;
  const warning = empty.length ? `\n${REFUSED}${empty.join(", ")} ${empty.length === 1 ? "is" : "are"} empty, so the build did not produce a real result.` : "";
  return clip(`${warning.trim()}${warning ? "\n" : ""}${status}\n${result.output || "(no output)"}`);
}

export interface ToolOptions {
  confirm?: ConfirmChange;
  readImage?: ImageReader;
  journal?: ChangeJournal;
  readTerminal?: () => string;
  mcp?: McpManager;
  mcpTools?: ToolDefinition[];
}

async function callMcpTool(name: string, args: Record<string, unknown>, options: ToolOptions, confirm: ConfirmChange, signal?: AbortSignal): Promise<string> {
  if (!(await confirm({ kind: "tool", title: `Run ${name}?`, detail: preview(JSON.stringify(args, null, 2)) }))) {
    return "The user denied this tool call.";
  }
  try {
    const result = await options.mcp?.call(name, args, signal);
    options.journal?.recordCommand(!result?.startsWith("The tool reported an error"));
    return clip(result ?? "The MCP server isn't available.");
  } catch (error) {
    options.journal?.recordCommand(false);
    return `The MCP tool failed: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}

export function createToolRunner(mode: ChatMode, options: ToolOptions = {}): ToolRunner {
  const { confirm = async () => false, readImage, journal, readTerminal, mcp, mcpTools = [] } = options;
  return {
    definitions: [...toolsForMode(mode), ...mcpTools],
    async run(call, signal) {
      const name = call.function.name;
      if (mcpTools.some((tool) => tool.function.name === name) && mcp?.has(name)) {
        return callMcpTool(name, argumentsOf(call), options, confirm, signal);
      }
      if (!isToolAllowed(mode, name)) {
        return `The tool ${name} is not available in ${mode} mode. Nothing was changed.`;
      }
      const args = argumentsOf(call);
      const text = (key: string): string => (typeof args[key] === "string" ? (args[key] as string) : "");
      const line = (key: string): number | undefined => (typeof args[key] === "number" ? (args[key] as number) : undefined);
      try {
        switch (name) {
          case "list_files":
            return await listFiles(text("pattern"));
          case "read_file":
            return await readFile(text("path"), line("start_line"), line("end_line"));
          case "search_text":
            return await searchText(text("query"), text("pattern"));
          case "find_code":
            return await findCode(text("query"));
          case "update_tasks":
            return "The user can see the task list.";
          case "get_problems":
            return getProblems(text("path"));
          case "read_terminal":
            return readTerminal?.() ?? "Terminal output isn't available.";
          case "probe_command":
            return await probeCommand(text("command"), signal);
          case "view_image":
            return await viewImage(text("path"), text("question"), readImage, signal);
          case "write_file":
            return await writeFile(text("path"), text("content"), confirm, journal);
          case "edit_file":
            return await editFile(text("path"), text("old_text"), text("new_text"), confirm, journal);
          case "run_command":
            return await runCommand(text("command"), confirm, signal, journal);
          default:
            return `Unknown tool: ${name}`;
        }
      } catch (error) {
        return `The tool failed: ${error instanceof Error ? error.message : "unknown error"}`;
      }
    },
  };
}
