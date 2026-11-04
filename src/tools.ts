import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { ChangeRequest, checkCommand, interactiveCommandHint } from "./approvals";
import type { ChangeJournal } from "./changeJournal";
import { REFUSED, ToolRunner } from "./chatEngine";
import { chunkFile, CodeChunk, rankChunks } from "./codeSearch";
import { BUILD_OUTPUT_GLOB, checkEditContent, checkFileContent, IMAGE_FILE } from "./contentGuard";
import type { ChatMode } from "./modes";
import type { McpManager } from "./mcpManager";
import type { ToolCall, ToolDefinition } from "./ollamaClient";
import { isInside, isSensitivePath } from "./pathGuard";
import type { Skill } from "./skillLoader";
import { runShell } from "./shell";
import { findTestCommand, summariseTestOutput } from "./projectSummary";
import { isToolAllowed, matchesIn, NEW_ERRORS, newProblems, replaceUnique, toolsForMode } from "./toolDefinitions";
import { webFetch, webSearch, WebSettings, webToolDefinitions } from "./webTools";

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
const MAX_SEARCH_CONTEXT = 10;
const TEST_TIMEOUT_MS = 300000;
/** Language servers can take a moment, and may send nothing if a file is unchanged. */
const PROBLEM_WAIT_MS = 2000;
const PROBLEM_SETTLE_MS = 300;
const MAX_NEW_PROBLEMS = 10;
const MAX_LOCATIONS = 30;
const NAV_ATTEMPTS = 5;
const NAV_RETRY_MS = 2000;
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

async function searchText(query: string, pattern?: string, contextLines = 0): Promise<string> {
  const context = Math.min(Math.max(Math.floor(contextLines), 0), MAX_SEARCH_CONTEXT);
  const needle = query.toLowerCase();
  if (!needle) {
    return "Enter some text to search for.";
  }
  const uris = await vscode.workspace.findFiles(pattern || "**/*", EXCLUDE, MAX_SEARCH_FILES);
  const matches: string[] = [];
  let found = 0;

  for (const uri of uris) {
    if (found >= MAX_MATCHES) {
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
      const hits = text.split(/\r?\n/).filter((line) => line.toLowerCase().includes(needle)).length;
      if (hits) {
        matches.push(...matchesIn(display(uri), text, needle, context, MAX_MATCHES - found));
        found += hits;
      }
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

/**
 * TypeScript only fully checks files in a tab, and gives shallow answers or no
 * errors for the rest. A preview tab reuses one slot, and focus stays where it is.
 */
async function openForLanguageServer(uri: vscode.Uri): Promise<void> {
  await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true }).then(undefined, () => undefined);
}

function errorsIn(uri: vscode.Uri): string[] {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((item) => item.severity === vscode.DiagnosticSeverity.Error)
    .map((item) => `Line ${item.range.start.line + 1}: ${item.message.split("\n")[0]}`);
}

/** Waits for the language server to look at a changed file. False means it said nothing. */
function diagnosticsUpdated(uri: vscode.Uri): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (updated: boolean): void => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(updated);
    };
    const timer = setTimeout(() => finish(false), PROBLEM_WAIT_MS);
    const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
      if (event.uris.some((changed) => changed.toString() === uri.toString())) {
        setTimeout(() => finish(true), PROBLEM_SETTLE_MS);
      }
    });
  });
}

/** Comes from the language server, so a model can't report success on code that doesn't compile. */
async function checkAfterEdit(uri: vscode.Uri, before: string[], updated: Promise<boolean>): Promise<string> {
  await openForLanguageServer(uri);
  if (!(await updated)) {
    return "";
  }
  const added = newProblems(before, errorsIn(uri));
  return added.length ? `\n${NEW_ERRORS}\n${added.slice(0, MAX_NEW_PROBLEMS).join("\n")}` : "\nNo new errors in this file.";
}

async function runTests(target: string, confirm: ConfirmChange, signal?: AbortSignal, journal?: ChangeJournal): Promise<string> {
  const root = folders()[0]?.uri.fsPath;
  if (!root) {
    return "An open workspace is required.";
  }
  const found = findTestCommand(root, target || undefined);
  if ("error" in found) {
    return found.error;
  }
  if (!(await confirm({ kind: "command", title: "Run the tests?", detail: preview(found.command), command: found.command }))) {
    return "The user denied this command.";
  }
  const result = await runShell(found.command, root, TEST_TIMEOUT_MS, signal);
  journal?.recordCommand(result.exitCode === 0);
  const status = result.stopped ? "Stopped by the user" : result.timedOut ? "Timed out" : `Exit code ${String(result.exitCode)}`;
  return `${status}\n${summariseTestOutput(result.output) || "(no output)"}`;
}

type NavLocation = vscode.Location | vscode.LocationLink;

/** Finds where to ask the language server from: a use in a file, or the workspace's symbol index. */
async function symbolPosition(symbol: string, requested: string, preferLast: boolean): Promise<{ uri: vscode.Uri; position: vscode.Position } | string> {
  const word = new RegExp(`\\b${symbol.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")}\\b`);
  const inDocument = async (uri: vscode.Uri, from = 0, last = false): Promise<{ uri: vscode.Uri; position: vscode.Position } | undefined> => {
    const document = await vscode.workspace.openTextDocument(uri);
    let found: { uri: vscode.Uri; position: vscode.Position } | undefined;
    for (let line = from; line < document.lineCount; line++) {
      const index = document.lineAt(line).text.search(word);
      if (index >= 0) {
        found = { uri, position: new vscode.Position(line, index) };
        if (!last) {
          break;
        }
      }
    }
    return found;
  };
  if (requested) {
    const file = await findFile(requested);
    if (typeof file === "string") {
      return file;
    }
    if (isSensitivePath(file.real)) {
      return "That file may contain secrets, so it can't be read.";
    }
    // The first mention is often an import, whose definition is the import itself.
    return (await inDocument(vscode.Uri.file(file.real), 0, preferLast)) ?? `${symbol} isn't in ${file.shown}.`;
  }
  const symbols = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", symbol)) ?? [];
  const exact = symbols.find((item) => item.name === symbol && !isSensitivePath(item.location.uri.fsPath));
  return exact ? ((await inDocument(exact.location.uri, exact.location.range.start.line)) ?? `${symbol} wasn't found.`) : `${symbol} wasn't found.`;
}

async function describeLocations(locations: NavLocation[]): Promise<string[]> {
  const lines: string[] = [];
  for (const location of locations.slice(0, MAX_LOCATIONS)) {
    const uri = "targetUri" in location ? location.targetUri : location.uri;
    const range = "targetUri" in location ? (location.targetSelectionRange ?? location.targetRange) : location.range;
    if (isSensitivePath(uri.fsPath)) {
      continue;
    }
    const text = await vscode.workspace.openTextDocument(uri).then((document) => document.lineAt(range.start.line).text.trim().slice(0, 160), () => "");
    lines.push(`${display(uri)}:${range.start.line + 1}: ${text}`);
  }
  return lines;
}

async function codeNav(action: string, symbol: string, requested: string): Promise<string> {
  if (!symbol) {
    return "Give a symbol to look up.";
  }
  const command = action === "references" ? "vscode.executeReferenceProvider" : "vscode.executeDefinitionProvider";
  let missing = "";
  // A language server that's still starting gives empty answers, not errors.
  for (let attempt = 0; attempt < NAV_ATTEMPTS; attempt++) {
    const found = await symbolPosition(symbol, requested, action !== "references");
    if (typeof found === "string") {
      missing = found;
    } else {
      await openForLanguageServer(found.uri);
      const locations = (await vscode.commands.executeCommand<NavLocation[]>(command, found.uri, found.position)) ?? [];
      const lines = await describeLocations(locations);
      // Until a project has loaded, TypeScript only follows a name as far as its import.
      const onlyImports = action !== "references" && lines.length > 0 && lines.every((line) => /:\d+: (import|from|export \{)/.test(line));
      if (lines.length && (!onlyImports || attempt === NAV_ATTEMPTS - 1)) {
        return clip(lines.join("\n"));
      }
      missing = `The language server found no ${action === "references" ? "references" : "definition"} for ${symbol}.`;
    }
    if (attempt < NAV_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, NAV_RETRY_MS));
    }
  }
  return `${missing} No language server may be running for this file, so try search_text.`;
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
  const errorsBefore = errorsIn(target.uri);
  const updated = diagnosticsUpdated(target.uri);
  if (present) {
    if (!(await replaceDocument(target.uri, content))) {
      return `Could not save ${target.shown}.`;
    }
    journal?.recordFile(target.uri.fsPath, target.shown, before, content);
    return `Replaced ${target.shown}.${await checkAfterEdit(target.uri, errorsBefore, updated)}`;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.uri.fsPath)));
  await vscode.workspace.fs.writeFile(target.uri, Buffer.from(content, "utf8"));
  journal?.recordFile(target.uri.fsPath, target.shown, null, content);
  return `Created ${target.shown}.${await checkAfterEdit(target.uri, errorsBefore, updated)}`;
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
  const errorsBefore = errorsIn(target.uri);
  const updated = diagnosticsUpdated(target.uri);
  if (!(await replaceDocument(target.uri, result.text))) {
    return `Could not save ${target.shown}.`;
  }
  journal?.recordFile(target.uri.fsPath, target.shown, before, result.text);
  return `Edited ${target.shown}.${await checkAfterEdit(target.uri, errorsBefore, updated)}`;
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
  const hint = result.exitCode === 0 ? interactiveCommandHint(command) : undefined;
  return clip(`${warning.trim()}${warning ? "\n" : ""}${status}\n${result.output || "(no output)"}${hint ? `\n${hint}` : ""}`);
}

export interface ToolOptions {
  confirm?: ConfirmChange;
  readImage?: ImageReader;
  journal?: ChangeJournal;
  readTerminal?: () => string;
  mcp?: McpManager;
  mcpTools?: ToolDefinition[];
  web?: WebSettings;
  skills?: Skill[];
}

async function callWebTool(name: string, args: Record<string, unknown>, web: WebSettings, confirm: ConfirmChange, signal?: AbortSignal): Promise<string> {
  const search = name === "web_search";
  const value = String((search ? args.query : args.url) ?? "").trim();
  if (!value) {
    return search ? "Give a query to search for." : "Give a full web address.";
  }
  const title = search ? "Search the web?" : "Open this web address?";
  if (!(await confirm({ kind: "tool", title, detail: preview(value) }))) {
    return "The user denied this web request.";
  }
  try {
    return await (search ? webSearch(value, web, signal) : webFetch(value, web, signal));
  } catch (error) {
    return `The web request failed: ${error instanceof Error ? error.message : "unknown error"}`;
  }
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
  const { confirm = async () => false, readImage, journal, readTerminal, mcp, mcpTools = [], web } = options;
  const webTools = web ? webToolDefinitions() : [];
  return {
    definitions: [...toolsForMode(mode), ...webTools, ...mcpTools],
    async run(call, signal) {
      const name = call.function.name;
      if (mcpTools.some((tool) => tool.function.name === name) && mcp?.has(name)) {
        return callMcpTool(name, argumentsOf(call), options, confirm, signal);
      }
      if (web && webTools.some((tool) => tool.function.name === name)) {
        return callWebTool(name, argumentsOf(call), web, confirm, signal);
      }
      if (!isToolAllowed(mode, name)) {
        // Models call skills as if they were tools. Giving them the skill is more use than an error.
        const skill = options.skills?.find((candidate) => candidate.name.replace(/-/g, "_") === name.replace(/-/g, "_"));
        if (skill) {
          return `${skill.title} is a skill, not a tool, so don't call it again. Follow these instructions:\n${clip(skill.content)}`;
        }
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
            return await searchText(text("query"), text("pattern"), line("context"));
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
          case "run_tests":
            return await runTests(text("target"), confirm, signal, journal);
          case "code_nav":
            return await codeNav(text("action"), text("symbol"), text("path"));
          default:
            return `Unknown tool: ${name}`;
        }
      } catch (error) {
        return `The tool failed: ${error instanceof Error ? error.message : "unknown error"}`;
      }
    },
  };
}
