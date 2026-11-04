import * as os from "os";
import * as path from "path";
import { fontFolder, fontsInstalled, installFonts, refreshFontCache } from "./fontInstall";
import { SavedSettings, syncVectorTheme, VectorThemeStore } from "./vectorTheme";
import * as vscode from "vscode";
import { ChatService } from "./chatService";
import { ChatViewProvider } from "./chatView";
import { CHATS_VIEW_ID, ChatsTree } from "./chatsTree";
import { getServerAddress, saveServerAddress } from "./config";
import { ConnectionMonitor, ConnectionState } from "./connection";
import { OllamaClient } from "./ollamaClient";
import { registerParticipant } from "./participant";
import { McpManager } from "./mcpManager";
import { TerminalLog } from "./terminalLog";
import { isInsecureRemote, parseServerAddress, ServerAddress, toBaseUrl, toLabel } from "./server";
import type { ChatRow } from "./savedChats";

export interface AstuteChatApi {
  service: ChatService;
  monitor: ConnectionMonitor;
  provider: ChatViewProvider;
}

const VECTOR_THEME_SAVED = "vectorTheme.saved";

function userFontFolder(): string | undefined {
  return fontFolder(process.platform, os.homedir(), process.env.XDG_DATA_HOME);
}

/** Fonts belong on the computer showing VS Code, and a remote extension can't reach it. */
async function installVectorFont(context: vscode.ExtensionContext): Promise<void> {
  const source = path.join(context.extensionPath, "media", "fonts");
  if (vscode.env.remoteName) {
    void vscode.window.showInformationMessage("Astute Vector Mono must be installed on your own computer, and this window is connected to a remote one. Install it from a local VS Code window.");
    return;
  }
  const folder = userFontFolder();
  if (!folder) {
    await vscode.env.openExternal(vscode.Uri.file(source));
    void vscode.window.showInformationMessage("Select the two AstuteVectorMono files in the folder that opened, right-click them and choose Install. Then restart VS Code.");
    return;
  }
  const install = "Install";
  const choice = await vscode.window.showInformationMessage("Install the Astute Vector Mono font for your user account?", { modal: true, detail: `This copies two font files to ${folder}. Other programs can use the font too.` }, install);
  if (choice !== install) {
    return;
  }
  await installFonts(source, folder);
  await refreshFontCache(process.platform, folder);
  const restart = "Reload Window";
  if ((await vscode.window.showInformationMessage("Astute Vector Mono is installed. Reload the window so the terminal can use it.", restart)) === restart) {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

async function offerVectorFont(context: vscode.ExtensionContext): Promise<void> {
  const folder = userFontFolder();
  if (vscode.env.remoteName || (folder && (await fontsInstalled(folder)))) {
    return;
  }
  const install = "Install Font";
  if ((await vscode.window.showInformationMessage("The terminal needs the Astute Vector Mono font to match the chat.", install)) === install) {
    await installVectorFont(context);
  }
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

  const vectorTheme: VectorThemeStore = {
    enabled: () => vscode.workspace.getConfiguration("astuteChat").get<boolean>("vectorTheme.enabled", false),
    read: (key) => vscode.workspace.getConfiguration().inspect<string | number>(key)?.globalValue,
    write: (key, value) => vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global),
    saved: () => context.globalState.get<SavedSettings>(VECTOR_THEME_SAVED),
    save: (value) => context.globalState.update(VECTOR_THEME_SAVED, value),
  };
  // Changes run in turn, because writing these settings fires the change event again.
  let themeSync = Promise.resolve();
  const applyVectorTheme = (): void => {
    themeSync = themeSync.then(async () => {
      if ((await syncVectorTheme(vectorTheme)) === "applied") {
        void offerVectorFont(context);
      }
    }).catch((error: unknown) => {
      log.error(`Couldn't change the Astute Vector theme: ${String(error)}`);
      void vscode.window.showErrorMessage("Astute Chat couldn't change the Astute Vector theme. Astute Chat: Show Logs has the details.");
    });
  };
  applyVectorTheme();

  context.subscriptions.push(
    log,
    terminal,
    mcp,
    monitor,
    createStatusBar(monitor),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider),
    vscode.window.registerTreeDataProvider(CHATS_VIEW_ID, new ChatsTree(() => provider.chatRows, provider.onDidChangeChats)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("astuteChat.vectorTheme.enabled")) {
        applyVectorTheme();
      }
      if (event.affectsConfiguration("astuteChat.server") || event.affectsConfiguration("astuteChat.serverUrl")) {
        void monitor.refresh();
      } else if (event.affectsConfiguration("astuteChat.model")) {
        provider.postState();
      }
    }),
    vscode.commands.registerCommand("astuteChat.openChat", () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`)),
    vscode.commands.registerCommand("astuteChat.newChat", () => provider.clear()),
    vscode.commands.registerCommand("astuteChat.updateChatContext", () => provider.updateContext()),
    vscode.commands.registerCommand("astuteChat.openChatContext", () => provider.openContext()),
    vscode.commands.registerCommand("astuteChat.openSavedChat", async (id: number) => {
      if (await provider.openSavedChat(id)) {
        await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
      } else {
        void vscode.window.showInformationMessage("Wait for the reply to finish, or stop it, before opening another chat.");
      }
    }),
    vscode.commands.registerCommand("astuteChat.deleteSavedChat", (row: ChatRow) => provider.deleteChat(row.id)),
    vscode.commands.registerCommand("astuteChat.addToChat", async (target?: unknown, selected?: unknown) => {
      // Empty space in the Explorer passes an empty object, so check before using it.
      const uris = (Array.isArray(selected) && selected.length ? selected : [target]).filter((item): item is vscode.Uri => item instanceof vscode.Uri);
      await provider.addContext(uris);
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    }),
    vscode.commands.registerCommand("astuteChat.setServerAddress", () => setServerAddress(monitor)),
    vscode.commands.registerCommand("astuteChat.selectModel", () => selectModel(monitor, service)),
    vscode.commands.registerCommand("astuteChat.showLogs", () => log.show()),
    vscode.commands.registerCommand("astuteChat.installVectorFont", async () => {
      try {
        await installVectorFont(context);
      } catch (error) {
        log.error(`Couldn't install the font: ${String(error)}`);
        void vscode.window.showErrorMessage("Astute Chat couldn't install the font. Astute Chat: Show Logs has the details.");
      }
    }),
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
