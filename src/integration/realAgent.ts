import * as assert from "assert";
import { execFileSync } from "child_process";
import * as vscode from "vscode";
import type { AstuteChatApi } from "../extension";

/** Runs review mode or an MCP request through the real panel code with a real model. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<AstuteChatApi>("AstuteSystems.astute-chat-ollama");
  assert.ok(extension);
  const { provider } = await extension.activate();
  await vscode.commands.executeCommand("astuteChat.openChat");
  const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath as string;
  await provider.receive({ type: "selectMode", mode: (process.env.ASTUTE_MODE as "ask" | "agent") ?? "agent" });
  await provider.receive({ type: "selectApproval", level: "full" });
  if (process.env.ASTUTE_REVIEW) {
    await provider.receive({ type: "toggleReview" });
  }
  await provider.send(process.env.ASTUTE_PROMPT as string);
  const state = provider.lastReply;
  console.log("REAL tools:", JSON.stringify((state?.tools ?? []).map((call) => call.slice(0, 110))));
  console.log("REAL reply:", JSON.stringify((state?.content ?? "").slice(-1200)));
  console.log("REAL start:", JSON.stringify((state?.content ?? "").slice(0, 120)));
  console.log("REAL changes:", JSON.stringify(state?.changes));
  console.log("REAL notices2:", JSON.stringify(state?.notices));
  console.log("REAL stats:", JSON.stringify({ chars: state?.content?.length, thinking: state?.thinking?.length, summary: state?.summary, error: state?.error, tools: state?.tools?.length }));
  console.log("REAL review:", JSON.stringify(state?.review));
  console.log("REAL notices:", JSON.stringify(state?.notices ?? []));
  console.log("REAL model:", JSON.stringify((state as { summary?: string } | undefined)?.summary), "error:", JSON.stringify((state as { error?: string } | undefined)?.error));
  if (process.env.ASTUTE_REVIEW) {
    console.log("REAL branch:", execFileSync("git", ["branch", "--show-current"], { cwd: root }).toString().trim());
  }
}
