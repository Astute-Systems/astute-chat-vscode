import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { AstuteChatApi } from "../extension";

/** Real model, real VS Code, real tools: asks Agent to build a library. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<AstuteChatApi>("AstuteSystems.astute-chat-ollama");
  assert.ok(extension);
  const api = await extension.activate();
  const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath as string;
  const tools: string[] = [];
  const notices: string[] = [];
  let content = "";
  const started = Date.now();
  const result = await api.service.runTurn({
    prompt: process.env.ASTUTE_PROMPT as string,
    history: [],
    mode: (process.env.ASTUTE_MODE as "ask" | "agent") ?? "agent",
    images: process.env.ASTUTE_IMAGE ? [{ name: path.basename(process.env.ASTUTE_IMAGE), data: fs.readFileSync(process.env.ASTUTE_IMAGE).toString("base64") }] : undefined,
    confirm: async () => true,
    events: {
      onStatus: () => undefined,
      onThinking: () => undefined,
      onContent: (text) => (content += text),
      onTool: (text) => tools.push(text.slice(0, 260)),
      onNotice: (text) => notices.push(text),
    },
  });
  const files = fs.readdirSync(root).filter((name) => fs.statSync(path.join(root, name)).isFile());
  console.log("BUILD model:", result.model, "|", result.summary, `| ${Math.round((Date.now() - started) / 1000)}s`);
  console.log("BUILD tools:", JSON.stringify(tools));
  console.log("BUILD notices:", JSON.stringify(notices));
  console.log("BUILD files:", JSON.stringify(files));
  console.log("BUILD imageText:", JSON.stringify(result.imageText.slice(0, 170)));
  console.log("BUILD reply:", JSON.stringify(content.slice(-230)));
}
