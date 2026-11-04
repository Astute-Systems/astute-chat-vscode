import * as vscode from "vscode";
import { ChatRow } from "./savedChats";

export const CHATS_VIEW_ID = "astuteChat.chatsView";

/**
 * Lists chats in a native view. The Chat view's own session list needs the proposed
 * chatSessionsProvider API, which VS Code only allows for a few extensions.
 */
export class ChatsTree implements vscode.TreeDataProvider<ChatRow> {
  constructor(
    private readonly rows: () => ChatRow[],
    readonly onDidChangeTreeData: vscode.Event<void>,
  ) {}

  getChildren(): ChatRow[] {
    return this.rows();
  }

  getTreeItem(row: ChatRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.title);
    item.id = row.current ? "current" : `chat-${row.id}`;
    item.tooltip = row.title;
    item.iconPath = new vscode.ThemeIcon(row.current ? "comment-discussion" : "comment");
    item.description = row.current ? "Current" : new Date(row.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    item.contextValue = row.current ? undefined : "astuteSavedChat";
    item.command = row.current ? { command: "astuteChat.openChat", title: "Open Chat" } : { command: "astuteChat.openSavedChat", title: "Open Chat", arguments: [row.id] };
    return item;
  }
}
