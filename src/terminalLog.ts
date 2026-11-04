import * as vscode from "vscode";
import { stripTerminalCodes } from "./terminalCodes";

const MAX_COMMANDS = 5;
const MAX_OUTPUT_CHARS = 4000;

interface LoggedCommand {
  command: string;
  output: string;
  exitCode?: number;
}

/**
 * Keeps the last few commands from VS Code terminals. This needs shell
 * integration, which is on by default for bash, zsh, fish and PowerShell.
 */
export class TerminalLog implements vscode.Disposable {
  private readonly commands: LoggedCommand[] = [];
  private readonly running = new Map<vscode.TerminalShellExecution, LoggedCommand>();
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    this.subscriptions = [
      vscode.window.onDidStartTerminalShellExecution((event) => void this.capture(event.execution)),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const entry = this.running.get(event.execution);
        if (entry) {
          entry.exitCode = event.exitCode;
          this.running.delete(event.execution);
        }
      }),
    ];
  }

  private async capture(execution: vscode.TerminalShellExecution): Promise<void> {
    const entry: LoggedCommand = { command: execution.commandLine.value, output: "" };
    this.running.set(execution, entry);
    this.commands.push(entry);
    this.commands.splice(0, Math.max(0, this.commands.length - MAX_COMMANDS));
    for await (const data of execution.read()) {
      entry.output = (entry.output + stripTerminalCodes(data)).slice(-MAX_OUTPUT_CHARS);
    }
  }

  describe(): string {
    if (this.commands.length === 0) {
      return "No terminal commands have been seen yet.";
    }
    return this.commands.map((entry) => `$ ${entry.command}\n${entry.output.trim() || "(no output)"}\n[Exit code ${entry.exitCode ?? "unknown"}]`).join("\n\n");
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }
}
