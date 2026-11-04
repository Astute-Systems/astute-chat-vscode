import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { AstuteChatApi } from "../extension";

/** A real model works on the open file and in a selected folder, using only "this file" and "here". */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<AstuteChatApi>("AstuteSystems.astute-chat-ollama");
  assert.ok(extension);
  const { provider } = await extension.activate();
  await vscode.commands.executeCommand("astuteChat.openChat");
  const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath as string;
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "drivers"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/calc.c"), "int add(int a, int b) {\n    return a + b;\n}\n");
  await provider.receive({ type: "selectMode", mode: "agent" });
  await provider.receive({ type: "selectApproval", level: "auto" });

  await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, "src/calc.c")));
  await provider.send("Add a subtract function to this file.");
  console.log("CONTEXT calc.c:", JSON.stringify(fs.readFileSync(path.join(root, "src/calc.c"), "utf8")));

  await provider.receive({ type: "newChat" });
  await vscode.commands.executeCommand("astuteChat.addToChat", vscode.Uri.file(path.join(root, "drivers")), [vscode.Uri.file(path.join(root, "drivers"))]);
  await provider.send("Add a file called led.h with an include guard here.");
  console.log("CONTEXT files:", JSON.stringify(fs.readdirSync(root, { recursive: true }).map(String).sort()));
  console.log("CONTEXT led.h:", JSON.stringify(fs.existsSync(path.join(root, "drivers/led.h")) ? fs.readFileSync(path.join(root, "drivers/led.h"), "utf8").slice(0, 120) : null));
}
