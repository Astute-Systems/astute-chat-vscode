import * as vscode from "vscode";
import { ChatService } from "./chatService";
import { ChatViewProvider } from "./chatView";
import { getServerAddress, saveServerAddress } from "./config";
import { ConnectionMonitor, ConnectionState } from "./connection";
import { OllamaClient } from "./ollamaClient";
import { registerParticipant } from "./participant";
import { McpManager } from "./mcpManager";
import { TerminalLog } from "./terminalLog";
import { isInsecureRemote, parseServerAddress, ServerAddress, toBaseUrl, toLabel } from "./server";

export interface AstuteChatApi {
  service: ChatService;
  monitor: ConnectionMonitor;
  provider: ChatViewProvider;
}

function createStatusBar(monitor: ConnectionMonitor): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = "Astute Chat";
  item.command = "astuteChat.openChat";
  const render = (state: ConnectionState): void => {
    const icon = state.status === "connected" ? "$(check)" : state.status === "offline" ? "$(warning)" : "$(sync~spin)";
    item.text = `${icon} Astute ${state.server}`;
    item.tooltip = state.message;
  };
  render(monitor.state);
  item.show();
  monitor.onDidChange(render);
  return item;
}

async function setServerAddress(monitor: ConnectionMonitor): Promise<void> {
  const current = getServerAddress();
  const input = await vscode.window.showInputBox({
    title: "Ollama server address",
    prompt: "Enter an IP address or hostname, with an optional port. For example: 192.168.1.20:11434",
    value: `${current.https ? "https://" : ""}${toLabel(current)}`,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const parsed = parseServerAddress(value);
      return typeof parsed === "string" ? parsed : undefined;
    },
  });
  if (input === undefined) {
    return;
  }

  const address = parseServerAddress(input) as ServerAddress;
  const reachable = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Connecting to ${toLabel(address)}…` }, async () => {
    try {
      return { version: await new OllamaClient(toBaseUrl(address)).version() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Could not connect." };
    }
  });

  if ("error" in reachable) {
    const choice = await vscode.window.showWarningMessage(`${reachable.error} Save this address anyway?`, { modal: true }, "Save Anyway");
    if (choice !== "Save Anyway") {
      return;
    }
  }

  if (isInsecureRemote(address)) {
    const choice = await vscode.window.showWarningMessage(
      `Prompts and code will be sent to ${toLabel(address)} without encryption.`,
      { modal: true, detail: "Ollama has no authentication. Use this only on a network you trust, or put the server behind a TLS proxy." },
      "Use This Server",
    );
    if (choice !== "Use This Server") {
      return;
    }
  }

  await saveServerAddress(address);
  await monitor.refresh();
}

async function selectModel(monitor: ConnectionMonitor, service: ChatService): Promise<void> {
  const state = await monitor.refresh();
  if (state.models.length === 0) {
    void vscode.window.showWarningMessage(state.status === "connected" ? "This Ollama server has no models." : state.message);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    state.models.map((model) => ({ label: model.name, description: `${(model.size / 1e9).toFixed(1)} GB` })),
    { title: "Select an Ollama model" },
  );
  if (picked) {
    await service.switchModel(picked.label);
    await monitor.refresh();
  }
}

export function activate(context: vscode.ExtensionContext): AstuteChatApi {
  const log = vscode.window.createOutputChannel("Astute Chat", { log: true });
  const monitor = new ConnectionMonitor(log);
  const terminal = new TerminalLog();
  const mcp = new McpManager(log);
  const service = new ChatService(log, terminal, mcp);
  const provider = new ChatViewProvider(context, service, monitor, log);

  context.subscriptions.push(
    log,
    terminal,
    mcp,
    monitor,
    createStatusBar(monitor),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("astuteChat.server") || event.affectsConfiguration("astuteChat.serverUrl")) {
        void monitor.refresh();
      } else if (event.affectsConfiguration("astuteChat.model")) {
        provider.postState();
      }
    }),
    vscode.commands.registerCommand("astuteChat.openChat", () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`)),
    vscode.commands.registerCommand("astuteChat.newChat", () => provider.clear()),
    vscode.commands.registerCommand("astuteChat.addToChat", async (target?: unknown, selected?: unknown) => {
      // Empty space in the Explorer passes an empty object, so check before using it.
      const uris = (Array.isArray(selected) && selected.length ? selected : [target]).filter((item): item is vscode.Uri => item instanceof vscode.Uri);
      await provider.addContext(uris);
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    }),
    vscode.commands.registerCommand("astuteChat.setServerAddress", () => setServerAddress(monitor)),
    vscode.commands.registerCommand("astuteChat.selectModel", () => selectModel(monitor, service)),
    vscode.commands.registerCommand("astuteChat.showLogs", () => log.show()),
    vscode.commands.registerCommand("astuteChat.reloadSkills", () => {
      const count = service.skills().length;
      void vscode.window.showInformationMessage(count ? `Loaded ${count} Astute skill(s).` : "No Astute skills found in .astute/skills.");
    }),
    vscode.commands.registerCommand("astuteChat.checkConnection", async () => {
      const state = await monitor.refresh();
      if (state.status === "connected") {
        void vscode.window.showInformationMessage(state.message);
      } else {
        const choice = await vscode.window.showWarningMessage(state.message, "Set Server Address", "Show Logs");
        if (choice === "Set Server Address") {
          await setServerAddress(monitor);
        } else if (choice === "Show Logs") {
          log.show();
        }
      }
    }),
  );

  registerParticipant(context, service);
  void monitor.refresh();
  return { service, monitor, provider };
}

export function deactivate(): void {
  // Everything is released through context.subscriptions.
}
