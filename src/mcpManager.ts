import * as vscode from "vscode";
import type { McpServerConfig } from "./mcpClient";
import { McpPool } from "./mcpPool";

/**
 * Starts the servers in the user's settings the first time Agent needs them.
 * They run as local programs, so servers can't come from a workspace.
 */
export class McpManager extends McpPool implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;

  constructor(log: vscode.LogOutputChannel) {
    super(
      () => vscode.workspace.getConfiguration("astuteChat").get<Record<string, McpServerConfig>>("mcp.servers", {}),
      () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      log,
    );
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("astuteChat.mcp.servers")) {
        this.stop();
      }
    });
  }

  dispose(): void {
    this.stop();
    this.subscription.dispose();
  }
}
