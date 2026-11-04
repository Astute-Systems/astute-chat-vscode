import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { IMAGE_FILE } from "./contentGuard";
import { isInside } from "./pathGuard";

const EXCLUDE = "**/{node_modules,.git,out,dist,build,.vscode-test}/**";
const MAX_REFERENCES = 200;
const MAX_NAME_SEARCHES = 40;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

async function fileInWorkspace(requested: string): Promise<string | undefined> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const root = await fs.realpath(folder.uri.fsPath);
      const candidate = path.resolve(root, requested);
      if (!isInside(root, candidate)) {
        continue;
      }
      const real = await fs.realpath(candidate);
      if (isInside(root, real) && (await fs.stat(real)).isFile()) {
        return real;
      }
    } catch {
      // Not in this workspace folder.
    }
  }
  return undefined;
}

/** The real path of a file or folder, if it's inside the workspace. */
export async function workspacePath(target: string): Promise<string | undefined> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const root = await fs.realpath(folder.uri.fsPath);
      const real = await fs.realpath(target);
      if (isInside(root, real)) {
        return real;
      }
    } catch {
      // It doesn't exist, or it isn't in this workspace folder.
    }
  }
  return undefined;
}

/** Finds a bare name such as add.c, but only when exactly one file matches. */
async function fileByName(name: string): Promise<string | undefined> {
  const matches = await vscode.workspace.findFiles(`**/${name}`, EXCLUDE, 2);
  return matches.length === 1 ? fileInWorkspace(matches[0].fsPath) : undefined;
}

/** Maps each reference that exists in the workspace to its full path. */
export async function resolveFiles(references: readonly string[]): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  let searches = 0;
  for (const reference of new Set(references.slice(0, MAX_REFERENCES))) {
    let file = await fileInWorkspace(reference);
    if (!file && !reference.includes("/") && searches < MAX_NAME_SEARCHES) {
      searches += 1;
      file = await fileByName(reference);
    }
    if (file) {
      resolved[reference] = file;
    }
  }
  return resolved;
}

/** Opens a workspace file. The path is checked again because it came from the webview. */
export async function openWorkspaceFile(file: string, line?: number, column?: number): Promise<boolean> {
  const real = await fileInWorkspace(file);
  if (!real) {
    return false;
  }
  const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (column ?? 1) - 1));
  const options: vscode.TextDocumentShowOptions | undefined = line ? { selection: new vscode.Range(position, position) } : undefined;
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(real), options);
  return true;
}

/** Reads images dragged from the Explorer, which arrive as URIs rather than file data. */
export async function readDroppedImages(uris: readonly string[]): Promise<{ images: Array<{ name: string; dataUrl: string }>; errors: string[] }> {
  const images: Array<{ name: string; dataUrl: string }> = [];
  const errors: string[] = [];
  for (const text of uris.slice(0, 5)) {
    const uri = vscode.Uri.parse(text);
    const name = path.basename(uri.path);
    if (uri.scheme !== "file" || !IMAGE_FILE.test(name)) {
      errors.push(`${name || "That file"} isn't a PNG or JPEG.`);
      continue;
    }
    try {
      const stat = await fs.stat(uri.fsPath);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) {
        errors.push(`${name} is larger than 20 MB.`);
        continue;
      }
      const type = /\.png$/i.test(name) ? "image/png" : "image/jpeg";
      images.push({ name, dataUrl: `data:${type};base64,${(await fs.readFile(uri.fsPath)).toString("base64")}` });
    } catch {
      errors.push(`${name} couldn't be read.`);
    }
  }
  return { images, errors };
}
