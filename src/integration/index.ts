import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import * as vscode from "vscode";
import type { AstuteChatApi } from "../extension";
import { openWorkspaceFile, readDroppedImages, resolveFiles } from "../fileResolver";
import { parseServerAddress } from "../server";
import { line, startMock } from "../test/mockOllama";

const manifestCommands = ["openChat", "newChat", "setServerAddress", "selectModel", "checkConnection", "reloadSkills", "showLogs"];

const noEvents = { onStatus: () => undefined, onThinking: () => undefined, onContent: () => undefined, onTool: () => undefined, onNotice: () => undefined };

/** Plays back a list of tool calls, then a final reply. */
function script(calls: Array<{ name: string; args: Record<string, unknown> }>): (req: unknown, res: { end(text: string): void }) => void {
  let index = 0;
  return (_req, res) => {
    const call = calls[index++];
    res.end(
      call
        ? line({ message: { content: "", tool_calls: [{ function: { name: call.name, arguments: call.args } }] }, done: true, eval_count: 1 })
        : line({ message: { content: "finished" }, done: true, eval_count: 1 }),
    );
  };
}

/** Runs inside a real VS Code against a mock server, in a throwaway workspace. */
export async function run(): Promise<void> {
  const pass = (text: string): void => console.log(`SMOKE ok: ${text}`);
  const extension = vscode.extensions.getExtension<AstuteChatApi>("AstuteSystems.astute-chat-ollama");
  assert.ok(extension);
  const api = await extension.activate();
  pass("extension activated");

  const commands = await vscode.commands.getCommands(true);
  manifestCommands.forEach((name) => assert.ok(commands.includes(`astuteChat.${name}`), name));
  await vscode.commands.executeCommand("astuteChat.openChat");
  pass("commands registered and tab opened");

  const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath as string;
  let calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let responder = script(calls);
  const mock = await startMock((req, res) => responder(req, res as never));
  const address = parseServerAddress(mock.url.replace("http://", ""));
  assert.ok(typeof address !== "string");
  const config = vscode.workspace.getConfiguration("astuteChat");
  await config.update("server.host", address.host, vscode.ConfigurationTarget.Global);
  await config.update("server.port", address.port, vscode.ConfigurationTarget.Global);
  await config.update("model", "tiny:1b", vscode.ConfigurationTarget.Global);
  const state = await api.monitor.refresh();
  assert.equal(state.status, "connected", state.message);
  pass(`custom server address used: ${state.server}`);

  const turn = async (mode: "ask" | "plan" | "agent", steps: typeof calls, approve: boolean): Promise<string[]> => {
    calls = steps;
    responder = script(calls);
    const asked: string[] = [];
    await api.service.runTurn({
      prompt: "smoke",
      history: [],
      mode,
      confirm: async (request) => {
        asked.push(request.title);
        return approve;
      },
      events: noEvents,
    });
    return asked;
  };

  const file = path.join(root, "made/by/agent.txt");
  for (const mode of ["ask", "plan"] as const) {
    const asked = await turn(mode, [{ name: "write_file", args: { path: "made/by/agent.txt", content: "no" } }, { name: "run_command", args: { command: "touch ran.txt" } }], true);
    assert.deepEqual(asked, []);
    assert.ok(!fs.existsSync(file) && !fs.existsSync(path.join(root, "ran.txt")), mode);
    pass(`${mode} refused change tools the model called anyway`);
  }

  await turn("agent", [{ name: "write_file", args: { path: "made/by/agent.txt", content: "denied" } }], false);
  assert.ok(!fs.existsSync(file));
  pass("agent respected a denied change");

  const asked = await turn(
    "agent",
    [
      { name: "write_file", args: { path: "made/by/agent.txt", content: "one two\n" } },
      { name: "edit_file", args: { path: "made/by/agent.txt", old_text: "two", new_text: "three" } },
      { name: "write_file", args: { path: "../escape.txt", content: "no" } },
      { name: "write_file", args: { path: ".env", content: "no" } },
      { name: "run_command", args: { command: "echo ok > ran.txt" } },
    ],
    true,
  );
  assert.equal(fs.readFileSync(file, "utf8"), "one three\n");
  assert.ok(fs.existsSync(path.join(root, "ran.txt")));
  assert.ok(!fs.existsSync(path.join(root, "../escape.txt")) && !fs.existsSync(path.join(root, ".env")));
  assert.equal(asked.length, 3, JSON.stringify(asked));
  pass("agent created, edited and ran a command with approval, and refused unsafe paths");

  // The chat panel's approval flow, driven through the same messages the webview sends.
  const panel = api.provider;
  const waitFor = async (check: () => boolean, label: string): Promise<void> => {
    for (let i = 0; i < 200 && !check(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(check(), label);
  };
  const play = (steps: typeof calls): void => {
    calls = steps;
    responder = script(calls);
  };
  const decision = (value: "allow" | "deny"): Promise<void> => panel.receive({ type: "approvalDecision", id: panel.pendingApprovalId as number, decision: value });

  await panel.receive({ type: "selectMode", mode: "agent" });
  await panel.receive({ type: "selectApproval", level: "ask" });
  play([{ name: "write_file", args: { path: "panel.txt", content: "yes" } }]);
  let turn2 = panel.send("write it");
  await waitFor(() => panel.pendingApprovalId !== undefined, "approval card appears");
  assert.ok(!fs.existsSync(path.join(root, "panel.txt")), "nothing written before approval");
  await decision("allow");
  await turn2;
  assert.ok(fs.existsSync(path.join(root, "panel.txt")));
  pass("panel approval: file written only after Allow");

  play([{ name: "write_file", args: { path: "denied.txt", content: "no" } }]);
  turn2 = panel.send("write it");
  await waitFor(() => panel.pendingApprovalId !== undefined, "second card");
  await decision("deny");
  await turn2;
  assert.ok(!fs.existsSync(path.join(root, "denied.txt")));
  pass("panel approval: Deny blocked the write");

  play([{ name: "write_file", args: { path: "stopped.txt", content: "no" } }, { name: "write_file", args: { path: "stopped2.txt", content: "no" } }]);
  turn2 = panel.send("write it");
  await waitFor(() => panel.pendingApprovalId !== undefined, "third card");
  panel.stop();
  await turn2;
  assert.equal(panel.pendingApprovalId, undefined);
  assert.ok(!fs.existsSync(path.join(root, "stopped.txt")) && !fs.existsSync(path.join(root, "stopped2.txt")));
  pass("Stop ended a pending approval without writing");

  await panel.receive({ type: "selectApproval", level: "auto" });
  play([{ name: "write_file", args: { path: "auto.txt", content: "yes" } }, { name: "run_command", args: { command: "ls" } }]);
  await panel.send("safe work");
  assert.ok(fs.existsSync(path.join(root, "auto.txt")));
  pass("Auto approved a safe edit and a read-only command");

  play([{ name: "run_command", args: { command: "touch risky.txt" } }]);
  turn2 = panel.send("risky work");
  await waitFor(() => panel.pendingApprovalId !== undefined, "Auto pauses for risky command");
  assert.ok(!fs.existsSync(path.join(root, "risky.txt")));
  await decision("deny");
  await turn2;
  assert.ok(!fs.existsSync(path.join(root, "risky.txt")));
  pass("Auto paused for a risky command");

  play([{ name: "write_file", args: { path: "raised.txt", content: "yes" } }]);
  await panel.receive({ type: "selectApproval", level: "ask" });
  turn2 = panel.send("edit");
  await waitFor(() => panel.pendingApprovalId !== undefined, "card before raising level");
  await panel.receive({ type: "selectApproval", level: "edits" });
  await turn2;
  assert.ok(fs.existsSync(path.join(root, "raised.txt")));
  pass("raising the level released a waiting approval");

  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/linked.c"), "one\ntwo\nthree\nfour\n");
  fs.writeFileSync(path.join(root, "lib.a"), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(path.dirname(root), "outside.txt"), "secret");
  const found = await resolveFiles(["src/linked.c", "linked.c", "lib.a", "made/up.c", "ghost.ts", "../outside.txt", path.join(path.dirname(root), "outside.txt")]);
  assert.deepEqual(Object.keys(found).sort(), ["lib.a", "linked.c", "src/linked.c"]);
  pass("only files that really exist in the workspace get links");

  await panel.receive({ type: "openFile", file: found["src/linked.c"], line: 3, column: 2 });
  await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath === found["src/linked.c"], "file opened");
  const opened = vscode.window.activeTextEditor as vscode.TextEditor;
  assert.deepEqual([opened.selection.active.line, opened.selection.active.character], [2, 1]);
  pass("a link opened the file at its line and column");

  assert.equal(await openWorkspaceFile(path.join(path.dirname(root), "outside.txt")), false);
  assert.equal(await openWorkspaceFile(found["lib.a"]), true);
  pass("links refuse files outside the workspace and can open binary files");

  await panel.receive({ type: "selectApproval", level: "auto" });
  play([
    { name: "write_file", args: { path: "libfake.a", content: "" } },
    { name: "write_file", args: { path: "empty.c", content: "" } },
    { name: "write_file", args: { path: "stub.c", content: "int add(void) {\n  // your code here\n}\n" } },
    { name: "run_command", args: { command: "touch sneaky.a" } },
  ]);
  const dummy = panel.send("make lib");
  await waitFor(() => panel.pendingApprovalId !== undefined, "touch needs approval");
  await decision("allow");
  await dummy;
  for (const name of ["libfake.a", "empty.c", "stub.c"]) {
    assert.ok(!fs.existsSync(path.join(root, name)), name);
  }
  pass("dummy files were refused before approval");

  fs.writeFileSync(path.join(root, "AGENTS.md"), "Always use tabs.");
  await turn("ask", [], false);
  const plain = (mock.requests.filter((request) => request.path === "/api/chat").at(-1)?.body.messages[0].content ?? "") as string;
  assert.ok(plain.includes("Always use tabs."), "AGENTS.md is on by default");
  assert.ok(!plain.includes("Follow these C rules"), "language skills are off by default");
  await config.update("languageSkills", true, vscode.ConfigurationTarget.Global);
  await turn("ask", [], false);
  const prompt = (mock.requests.filter((request) => request.path === "/api/chat").at(-1)?.body.messages[0].content ?? "") as string;
  assert.ok(prompt.includes("Always use tabs."), "AGENTS.md reaches the model");
  assert.ok(prompt.includes("for this system only"), "the host system reaches the model");
  assert.ok(prompt.includes(`Workspace root: ${root}.`), "the workspace root reaches the model");
  assert.ok(prompt.includes("Follow these C rules"), "the C skill loads from project files");
  assert.ok(!prompt.includes("Follow these Python rules"), "unrelated skills stay out");
  pass("AGENTS.md and the matching language skill reached the model");

  fs.writeFileSync(path.join(root, "dropped.png"), Buffer.from([137, 80, 78, 71]));
  const dropped = await readDroppedImages([vscode.Uri.file(path.join(root, "dropped.png")).toString(), vscode.Uri.file(path.join(root, "AGENTS.md")).toString()]);
  assert.deepEqual(dropped.images, [{ name: "dropped.png", dataUrl: "data:image/png;base64,iVBORw==" }]);
  assert.equal(dropped.errors.length, 1);
  pass("images dragged from the Explorer are read, and other files are refused");

  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(() => !vscode.window.activeTextEditor, "editors closed");
  fs.mkdirSync(path.join(root, "drivers"), { recursive: true });
  fs.writeFileSync(path.join(root, "drivers/bus.c"), "int bus;\n");
  await vscode.window.showTextDocument(vscode.Uri.file(found["src/linked.c"]));
  const sentPrompt = async (): Promise<{ text: string; history: string }> => {
    play([]);
    await panel.send("what is this");
    const messages = mock.requests.filter((request) => request.path === "/api/chat").at(-1)?.body.messages as Array<{ content: string }>;
    return { text: messages[messages.length - 1].content, history: messages.slice(0, -1).map((message) => message.content).join("") };
  };
  await panel.receive({ type: "newChat" });
  await panel.receive({ type: "selectMode", mode: "ask" });
  let sent = await sentPrompt();
  assert.ok(sent.text.includes("src/linked.c") && sent.text.includes("three"), "open file reaches the model");
  await vscode.commands.executeCommand("astuteChat.addToChat", vscode.Uri.file(path.join(root, "drivers")), [vscode.Uri.file(path.join(root, "drivers"))]);
  sent = await sentPrompt();
  assert.ok(sent.text.includes("selected the folder drivers/") && sent.text.includes("bus.c"), "right-click adds the folder");
  assert.ok(!sent.history.includes("selected the folder"), "context isn't stored in history");
  await vscode.commands.executeCommand("astuteChat.addToChat", {}, []);
  await panel.receive({ type: "removeContext", item: "drivers" });
  await panel.receive({ type: "removeContext", item: "src/linked.c" });
  sent = await sentPrompt();
  assert.ok(!sent.text.includes("selected the folder") && !sent.text.includes("three"), "removed context stays out");
  await panel.receive({ type: "newChat" });
  pass("open file and Explorer folder reach the model, and can be removed");

  await panel.receive({ type: "newChat" });
  await panel.receive({ type: "selectMode", mode: "agent" });
  await panel.receive({ type: "selectApproval", level: "ask" });
  fs.writeFileSync(path.join(root, "undo.c"), "int one;\n");
  play([{ name: "edit_file", args: { path: "undo.c", old_text: "one", new_text: "two" } }]);
  const reviewing = panel.send("edit it");
  await waitFor(() => panel.pendingApprovalId !== undefined, "edit waits for approval");
  await panel.receive({ type: "showDiff", id: panel.pendingApprovalId as number });
  await waitFor(() => vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => tab.input instanceof vscode.TabInputTextDiff), "diff opens");
  assert.equal(fs.readFileSync(path.join(root, "undo.c"), "utf8"), "int one;\n", "showing a diff changes nothing");
  await decision("allow");
  await reviewing;
  play([{ name: "write_file", args: { path: "undo-new.c", content: "int fresh;\n" } }]);
  await panel.receive({ type: "selectApproval", level: "auto" });
  await panel.send("make a file");
  assert.equal(fs.readFileSync(path.join(root, "undo.c"), "utf8"), "int two;\n");
  assert.ok(fs.existsSync(path.join(root, "undo-new.c")));
  const [editTurn, createTurn] = panel.undoIds.slice(-2);
  await panel.receive({ type: "undoTurn", id: createTurn });
  assert.ok(!fs.existsSync(path.join(root, "undo-new.c")), "Undo removes a created file");
  await panel.receive({ type: "undoTurn", id: editTurn });
  await waitFor(() => fs.readFileSync(path.join(root, "undo.c"), "utf8") === "int one;\n", "Undo restores an edit");
  pass("the diff opens from an approval, and Undo restores Agent's files");

  await panel.receive({ type: "newChat" });
  await panel.receive({ type: "selectMode", mode: "ask" });
  const diagnostics = vscode.languages.createDiagnosticCollection("astute-test");
  diagnostics.set(vscode.Uri.file(path.join(root, "src/linked.c")), [new vscode.Diagnostic(new vscode.Range(2, 0, 2, 5), "'i2c_bus' undeclared", vscode.DiagnosticSeverity.Error)]);
  play([{ name: "get_problems", args: {} }]);
  await panel.send("any errors?");
  const toolResults = (): string[] => (mock.requests.filter((request) => request.path === "/api/chat").at(-1)?.body.messages ?? []).filter((message: { role: string }) => message.role === "tool").map((message: { content: string }) => message.content);
  assert.ok(toolResults()[0].includes("error src/linked.c:3: 'i2c_bus' undeclared"), toolResults()[0]);
  diagnostics.dispose();
  pass("get_problems reads the Problems panel");

  assert.ok((await panel.matchFiles("linked")).includes("src/linked.c"));
  assert.ok((await panel.matchFiles("driv")).includes("drivers/"));
  await panel.receive({ type: "addContextPath", item: "drivers/" });
  await panel.send("what is in here");
  const withPicked = (mock.requests.filter((request) => request.path === "/api/chat").at(-1)?.body.messages ?? []) as Array<{ content: string }>;
  assert.ok(withPicked.at(-1)?.content.includes("selected the folder drivers/"));
  await panel.receive({ type: "removeContext", item: "drivers" });
  pass("the @ picker finds files and folders and adds them");

  const shell = vscode.window.createTerminal("Log Test");
  shell.show();
  await waitFor(() => Boolean(shell.shellIntegration), "shell integration starts").catch(() => undefined);
  if (shell.shellIntegration) {
    const ended = new Promise<void>((resolve) => {
      const listener = vscode.window.onDidEndTerminalShellExecution(() => {
        listener.dispose();
        resolve();
      });
      setTimeout(resolve, 8000);
    });
    shell.shellIntegration.executeCommand("echo astute-terminal-marker");
    await ended;
    await new Promise((resolve) => setTimeout(resolve, 300));
    play([{ name: "read_terminal", args: {} }]);
    await panel.send("what did I run");
    assert.ok(toolResults()[0].includes("astute-terminal-marker"), toolResults()[0]);
    pass("read_terminal sees commands from the user's terminal");
  } else {
    pass("terminal check skipped, because shell integration didn't start");
  }
  shell.dispose();
  await waitFor(() => vscode.window.terminals.length === 0, "test terminal closes");

  await panel.receive({ type: "newChat" });
  const long = "x".repeat(6000);
  play([]);
  for (const question of ["first", "second", "third", "fourth"]) {
    await panel.send(`${question} ${long}`);
  }
  const summaryCalls = mock.requests.filter((request) => request.path === "/api/chat" && request.body.messages[0].content.startsWith("Summarise this conversation"));
  assert.ok(summaryCalls.length >= 1, "older turns are summarised");
  const latest = mock.requests.filter((request) => request.path === "/api/chat").at(-1)?.body.messages as Array<{ content: string }>;
  assert.ok(latest[0].content.includes("Summary of the earlier conversation:"), "the next request uses the summary");
  await panel.receive({ type: "newChat" });
  pass("long chats are summarised instead of dropped");

  await panel.receive({ type: "selectMode", mode: "ask" });
  fs.writeFileSync(path.join(root, "src/retry.c"), "int reconnect_with_retry(int attempts) {\n  return attempts;\n}\n");
  play([{ name: "find_code", args: { query: "how do we retry a connection" } }]);
  await panel.send("find it");
  assert.ok(toolResults()[0].startsWith("src/retry.c, from line 1"), toolResults()[0]);
  pass("find_code finds code from a plain description");

  await panel.receive({ type: "newChat" });
  play([]);
  await panel.send("remember this chat");
  const savedBefore = panel.chatList.length;
  await panel.receive({ type: "newChat" });
  assert.equal(panel.chatList.length, savedBefore + 1, "New Chat saves the chat");
  assert.equal(panel.chatList[0].title, "remember this chat");
  await panel.send("second chat");
  await panel.receive({ type: "openChat", id: panel.chatList[0].id });
  assert.ok(panel.chatList.some((chat) => chat.title === "second chat"), "the chat you leave is saved too");
  play([]);
  await panel.send("carry on");
  const reopened = (mock.requests.filter((request) => request.path === "/api/chat").at(-1)?.body.messages ?? []) as Array<{ content: string }>;
  assert.ok(reopened.some((message) => message.content === "remember this chat"), "the old chat continues with its history");
  await panel.receive({ type: "deleteChat", id: panel.chatList[0].id });
  pass("chat history saves, reopens and deletes chats");
  await panel.receive({ type: "newChat" });

  await panel.receive({ type: "selectMode", mode: "ask" });
  await panel.receive({ type: "selectApproval", level: "ask" });
  play([{ name: "probe_command", args: { command: "pwd" } }, { name: "probe_command", args: { command: "touch probed.txt" } }]);
  await panel.send("where am I");
  assert.equal(panel.pendingApprovalId, undefined);
  assert.ok(!fs.existsSync(path.join(root, "probed.txt")), "a changing command is refused in Ask");
  const probes = mock.requests.filter((request) => request.path === "/api/chat").at(-1)?.body.messages.filter((message: { role: string }) => message.role === "tool");
  assert.ok(probes[0].content.includes(root) && probes[1].content.includes("isn't read-only"), JSON.stringify(probes));
  pass("probe_command runs read-only commands in Ask, and refuses others");

  await panel.receive({ type: "selectMode", mode: "agent" });
  await panel.receive({ type: "selectApproval", level: "ask" });
  play([{ name: "run_command", args: { command: "touch released.txt" } }]);
  const waiting = panel.send("run it");
  await waitFor(() => panel.pendingApprovalId !== undefined, "command waits before Auto is on");
  await panel.receive({ type: "selectApproval", level: "full" });
  await waiting;
  assert.ok(fs.existsSync(path.join(root, "released.txt")));
  play([
    { name: "run_command", args: { command: "touch full-auto.txt" } },
    { name: "write_file", args: { path: "package.json", content: "{}" } },
    { name: "write_file", args: { path: "../escape2.txt", content: "no" } },
    { name: "write_file", args: { path: ".env", content: "no" } },
    { name: "write_file", args: { path: "libfull.a", content: "" } },
  ]);
  await panel.send("do everything");
  assert.equal(panel.pendingApprovalId, undefined);
  assert.ok(fs.existsSync(path.join(root, "full-auto.txt")) && fs.existsSync(path.join(root, "package.json")));
  assert.ok(!fs.existsSync(path.join(root, "../escape2.txt")) && !fs.existsSync(path.join(root, ".env")) && !fs.existsSync(path.join(root, "libfull.a")));
  pass("full Auto never asks, and the hard limits still hold");
  await panel.receive({ type: "selectApproval", level: "ask" });

  await panel.receive({ type: "copyText", text: "copied snippet" });
  // Desktop clipboards can refuse a window without focus, and it then still holds what the user copied.
  const pasted = await vscode.env.clipboard.readText();
  assert.ok(pasted === "copied snippet" || !vscode.window.state.focused, "Copy put the snippet on the clipboard");
  pass(pasted === "copied snippet" ? "Copy put the snippet on the clipboard" : "clipboard check skipped, because the test window has no focus");

  const before = vscode.window.terminals.length;
  await panel.receive({ type: "runInTerminal", text: "echo new > terminal-new.txt" });
  await waitFor(() => fs.existsSync(path.join(root, "terminal-new.txt")), "command ran in a new terminal");
  assert.equal(vscode.window.terminals.length, before + 1);
  assert.equal(vscode.window.activeTerminal?.name, "Astute Chat");
  pass("Run opened a terminal in the workspace when none was open");

  const mine = vscode.window.createTerminal("My Terminal");
  mine.show();
  await waitFor(() => vscode.window.activeTerminal === mine, "my terminal is active");
  const count = vscode.window.terminals.length;
  await panel.receive({ type: "runInTerminal", text: `cd ${root} && echo mine > terminal-mine.txt` });
  await waitFor(() => fs.existsSync(path.join(root, "terminal-mine.txt")), "command ran in my terminal");
  assert.equal(vscode.window.terminals.length, count);
  assert.equal(vscode.window.activeTerminal, mine);
  pass("Run used the terminal that was already open");

  await panel.receive({ type: "selectApproval", level: "ask" });
  await panel.receive({ type: "selectMode", mode: "agent" });
  const serverFile = path.join(root, "..", "astute-mcp-test.js");
  fs.writeFileSync(serverFile, `const rl = require("readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
rl.on("line", (line) => { const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1" } } });
  if (m.method === "tools/list") send({ id: m.id, result: { tools: [{ name: "lookup", description: "Look up a part", inputSchema: { type: "object", properties: { part: { type: "string" } } } }] } });
  if (m.method === "tools/call") send({ id: m.id, result: { content: [{ type: "text", text: "part " + m.params.arguments.part + " is in stock" }] } }); });`);
  await config.update("mcp.servers", { demo: { command: process.execPath, args: [serverFile] } }, vscode.ConfigurationTarget.Global);
  play([{ name: "mcp_demo_lookup", args: { part: "R12" } }]);
  const mcpTurn = panel.send("is R12 in stock");
  await waitFor(() => panel.pendingApprovalId !== undefined, "an MCP tool asks first");
  const offered = (mock.requests.filter((request) => request.path === "/api/chat").at(-1)?.body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
  assert.ok(offered.includes("mcp_demo_lookup"), "Agent is offered the tool");
  await decision("allow");
  await mcpTurn;
  assert.ok(toolResults().some((result) => result.includes("part R12 is in stock")), toolResults().join());
  await panel.receive({ type: "selectMode", mode: "ask" });
  play([]);
  await panel.send("anything");
  const askTools = (mock.requests.filter((request) => request.path === "/api/chat").at(-1)?.body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
  assert.ok(!askTools.includes("mcp_demo_lookup"), "Ask isn't offered MCP tools");
  await config.update("mcp.servers", undefined, vscode.ConfigurationTarget.Global);
  fs.rmSync(serverFile);
  pass("MCP tools come from user settings, ask first, and stay out of Ask");

  const offeredNames = (): string[] => (mock.requests.filter((request) => request.path === "/api/chat").at(-1)?.body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
  await panel.receive({ type: "selectMode", mode: "ask" });
  await panel.receive({ type: "selectApproval", level: "ask" });
  play([]);
  await panel.send("look this up");
  assert.ok(!offeredNames().some((name) => name.startsWith("web_")), "web tools are off by default");
  const searches: string[] = [];
  const searchServer = http.createServer((request, response) => {
    searches.push(request.url ?? "");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ results: [{ title: "Astute result", url: "https://result.example/", content: "the search worked" }] }));
  });
  await new Promise<void>((resolve) => searchServer.listen(0, "127.0.0.1", resolve));
  await config.update("web.enabled", true, vscode.ConfigurationTarget.Global);
  await config.update("web.searchUrl", `http://127.0.0.1:${(searchServer.address() as AddressInfo).port}`, vscode.ConfigurationTarget.Global);
  play([{ name: "web_search", args: { query: "denied search" } }]);
  const denied = panel.send("search for it");
  await waitFor(() => panel.pendingApprovalId !== undefined, "a search asks first in Ask");
  assert.ok(offeredNames().includes("web_search") && offeredNames().includes("web_fetch"), "Ask is offered web tools");
  await decision("deny");
  await denied;
  assert.equal(searches.length, 0, "a denied search sends nothing");
  play([{ name: "web_search", args: { query: "allowed search" } }, { name: "web_fetch", args: { url: "http://127.0.0.1:1/private" } }]);
  const allowed = panel.send("search for it");
  await waitFor(() => panel.pendingApprovalId !== undefined, "a search asks first");
  await decision("allow");
  await waitFor(() => searches.length === 1 && panel.pendingApprovalId !== undefined, "a fetch asks too");
  await decision("allow");
  await allowed;
  assert.ok(searches[0].includes("q=allowed+search") && searches[0].includes("format=json"), searches[0]);
  assert.ok(toolResults().some((result) => result.includes("the search worked")), toolResults().join());
  assert.ok(toolResults().some((result) => result.includes("private network")), toolResults().join());
  await config.update("web.enabled", undefined, vscode.ConfigurationTarget.Global);
  await config.update("web.searchUrl", undefined, vscode.ConfigurationTarget.Global);
  await new Promise((resolve) => searchServer.close(resolve));
  pass("web tools are off by default, ask first in Ask, and can't reach private addresses");

  await panel.receive({ type: "selectMode", mode: "agent" });
  await panel.receive({ type: "selectApproval", level: "full" });
  play([{ name: "run_command", args: { command: "echo model not found; exit 3" } }]);
  await panel.send("run it");
  const failedReply = panel.lastReply;
  assert.equal(failedReply?.changes?.commands, 1, JSON.stringify(failedReply?.changes));
  assert.equal(failedReply?.changes?.failedCommands, 1);
  assert.ok(toolResults().some((result) => result.startsWith("Exit code 3") && result.includes("model not found")), toolResults().join());
  assert.ok(failedReply?.notices?.some((notice) => notice.includes("model not found")), JSON.stringify(failedReply?.notices));
  await panel.receive({ type: "selectApproval", level: "ask" });
  pass("a failed command reaches the report with its error");

  const skillFile = path.join(root, ".astute", "skills", "forced-skill.md");
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, "# Forced Skill\n\nAlways say the word HERON.\n");
  await panel.receive({ type: "selectMode", mode: "ask" });
  play([{ name: "forced_skill", args: {} }]);
  await panel.send("/agent /forced-skill do the thing");
  const skillMessages = mock.requests.filter((request) => request.path === "/api/chat").at(-1)?.body.messages as Array<{ role: string; content: string }>;
  assert.ok(skillMessages[0].content.includes("Always say the word HERON"), "the skill is in the system prompt");
  assert.ok(skillMessages.some((message) => message.role === "user" && message.content.includes("The user chose the Forced Skill skill")));
  assert.ok(panel.lastReply?.notices?.some((notice) => notice.includes("Read the Forced Skill skill")), JSON.stringify(panel.lastReply?.notices));
  assert.ok(toolResults().some((result) => result.includes("Always say the word HERON")), "calling it as a tool returns it");
  const beforeTypo = mock.requests.length;
  await panel.send("/forced-skil do the thing");
  assert.equal(mock.requests.length, beforeTypo, "a mistyped skill never reaches the model");
  fs.rmSync(skillFile);
  pass("/skill-name forces the skill, with a mode, and a mistyped name is refused");

  const navDir = path.join(root, "navtest");
  fs.mkdirSync(navDir, { recursive: true });
  fs.writeFileSync(path.join(navDir, "lib.ts"), "export function addNumbers(a: number, b: number): number {\n  return a + b;\n}\n");
  fs.writeFileSync(path.join(navDir, "use.ts"), "import { addNumbers } from \"./lib\";\nexport const total = addNumbers(1, 2);\n");
  await panel.receive({ type: "selectMode", mode: "ask" });
  play([{ name: "code_nav", args: { action: "definition", symbol: "addNumbers", path: "navtest/use.ts" } }]);
  await panel.send("where is it defined");
  assert.ok(toolResults().some((result) => result.includes("navtest/lib.ts:1:")), toolResults().join());
  play([{ name: "code_nav", args: { action: "references", symbol: "addNumbers", path: "navtest/lib.ts" } }]);
  await panel.send("where is it used");
  assert.ok(toolResults().some((result) => result.includes("navtest/use.ts:2:")), toolResults().join());
  await panel.receive({ type: "selectMode", mode: "agent" });
  await panel.receive({ type: "selectApproval", level: "full" });
  play([{ name: "edit_file", args: { path: "navtest/lib.ts", old_text: "return a + b;", new_text: "return \"oops\";" } }]);
  await panel.send("break it");
  assert.ok(toolResults().some((result) => result.includes("New errors after this change:") && result.includes("not assignable")), toolResults().join());
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "echo 1 test failing; exit 4" } }));
  play([{ name: "run_tests", args: {} }]);
  await panel.send("run the tests");
  assert.ok(toolResults().some((result) => result.startsWith("Exit code 4") && result.includes("1 test failing")), toolResults().join());
  assert.equal(panel.lastReply?.changes?.failedCommands, 1);
  play([{ name: "run_tests", args: { target: "a; touch hacked" } }]);
  await panel.send("run one test");
  assert.ok(!fs.existsSync(path.join(root, "hacked")), "a test name can't run commands");
  await panel.receive({ type: "selectApproval", level: "ask" });
  fs.rmSync(navDir, { recursive: true });
  pass("code_nav uses the language server, edits report new errors, and run_tests reports failures");

  const secretFile = path.join(root, ".env");
  fs.writeFileSync(secretFile, "AZURE-PAT=fake-secret-value\n");
  const secretEditor = await vscode.window.showTextDocument(vscode.Uri.file(secretFile));
  secretEditor.selection = new vscode.Selection(0, 0, 0, 27);
  await panel.receive({ type: "selectMode", mode: "ask" });
  play([]);
  await panel.send("use this token");
  const secretRequest = JSON.stringify(mock.requests.filter((request) => request.path === "/api/chat").at(-1)?.body.messages);
  assert.ok(secretRequest.includes("use this token"), "the message is still sent");
  assert.ok(!secretRequest.includes("fake-secret-value"), "selected secrets never reach the model");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  fs.rmSync(secretFile);
  pass("text selected in a secret file isn't sent");

  const editorConfig = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration();
  await editorConfig().update("workbench.colorTheme", "Default Light Modern", vscode.ConfigurationTarget.Global);
  await config.update("vectorTheme.enabled", true, vscode.ConfigurationTarget.Global);
  await waitFor(() => editorConfig().get("terminal.integrated.fontSize") === 13 && editorConfig().get("scm.inputFontFamily") !== "default", "the theme settings are applied");
  assert.equal(editorConfig().get("workbench.colorTheme"), "Astute Vector");
  assert.match(editorConfig().get<string>("terminal.integrated.fontFamily") ?? "", /^'Astute Vector Mono'/);
  await waitFor(() => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark, "the theme loads");
  await config.update("vectorTheme.enabled", false, vscode.ConfigurationTarget.Global);
  await waitFor(() => editorConfig().inspect("scm.inputFontFamily")?.globalValue === undefined, "the theme settings are restored");
  await waitFor(() => editorConfig().inspect("terminal.integrated.fontFamily")?.globalValue === undefined, "the terminal font is restored");
  assert.equal(editorConfig().get("workbench.colorTheme"), "Default Light Modern");
  assert.equal(editorConfig().inspect("editor.fontFamily")?.globalValue, undefined);
  assert.equal(editorConfig().inspect("terminal.integrated.fontSize")?.globalValue, undefined);
  await editorConfig().update("workbench.colorTheme", undefined, vscode.ConfigurationTarget.Global);
  pass("the Astute Vector option applies the theme and fonts, and restores them");

  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root }).toString().trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("add", "-A");
  git("commit", "-qm", "start");
  await panel.receive({ type: "newChat" });
  await panel.receive({ type: "selectMode", mode: "agent" });
  await panel.receive({ type: "selectApproval", level: "auto" });
  await panel.receive({ type: "toggleReview" });
  play([{ name: "write_file", args: { path: "reviewed.c", content: "int reviewed;\n" } }]);
  await panel.send("Add reviewed file");
  assert.equal(git("branch", "--show-current"), "astute/add-reviewed-file");
  assert.equal(git("show", "--format=%s", "-s"), "Astute Agent: Add reviewed file");
  assert.ok(!git("ls-tree", "--name-only", "main").includes("reviewed.c"), "the base branch is untouched");
  await panel.receive({ type: "reviewAction", branch: "astute/add-reviewed-file", action: "diff" });
  await panel.receive({ type: "reviewAction", branch: "astute/add-reviewed-file", action: "merge" });
  assert.equal(git("branch", "--show-current"), "main");
  assert.ok(git("ls-tree", "--name-only", "main").includes("reviewed.c"));
  play([{ name: "write_file", args: { path: "thrown.c", content: "int thrown;\n" } }]);
  await panel.send("Add thrown file");
  await panel.receive({ type: "reviewAction", branch: "astute/add-thrown-file", action: "discard" });
  assert.equal(git("branch", "--show-current"), "main");
  assert.ok(!fs.existsSync(path.join(root, "thrown.c")));
  await panel.receive({ type: "toggleReview" });
  pass("Review keeps Agent's work on a branch, then merges or discards it");

  await mock.close();
}
