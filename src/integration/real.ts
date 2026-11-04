import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { decide } from "../approvals";
import type { AstuteChatApi } from "../extension";

/** Runs the extension in a real VS Code against the real Ollama server. Set the model in settings. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<AstuteChatApi>("AstuteSystems.astute-chat-ollama");
  assert.ok(extension);
  const api = await extension.activate();
  await vscode.commands.executeCommand("astuteChat.openChat");
  const state = await api.monitor.refresh();
  assert.equal(state.status, "connected", state.message);
  console.log("REAL server:", state.message);

  const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath as string;
  const turn = async (mode: "ask" | "agent", prompt: string, signal?: AbortSignal, onContent?: () => void): Promise<void> => {
    const statuses = new Set<string>();
    const tools: string[] = [];
    let content = "";
    const result = await api.service.runTurn({
      prompt,
      history: [],
      mode,
      signal,
      confirm: async (request) => decide("auto", request).allow,
      events: {
        onStatus: (text) => statuses.add(text),
        onThinking: () => undefined,
        onContent: (text) => {
          content += text;
          onContent?.();
        },
        onTool: (text) => tools.push(text),
        onNotice: (text) => console.log("REAL notice:", text),
      },
    });
    const live = [...statuses].filter((text) => /t\/s/.test(text));
    console.log(`REAL ${mode} tools:`, JSON.stringify(tools));
    console.log(`REAL ${mode} reply:`, JSON.stringify(content.slice(0, 160)));
    console.log(`REAL ${mode} live:`, live[live.length - 1] ?? "(none)");
    console.log(`REAL ${mode} summary:`, result.model, "|", result.summary, "| cancelled:", result.cancelled);
  };

  await turn("ask", "Use read_file to read notes.txt, then tell me the codename in it.");
  await turn("agent", 'Use write_file to create hello.txt containing exactly: hello from astute');
  console.log("REAL hello.txt:", JSON.stringify(fs.existsSync(path.join(root, "hello.txt")) ? fs.readFileSync(path.join(root, "hello.txt"), "utf8") : null));

  const abort = new AbortController();
  let chunks = 0;
  const started = Date.now();
  await turn("ask", "Without using any tools, write a very long essay about mutexes.", abort.signal, () => {
    chunks += 1;
    if (chunks === 20) {
      abort.abort();
    }
  });
  console.log("REAL stop took", Date.now() - started, "ms, chunks", chunks);
}
