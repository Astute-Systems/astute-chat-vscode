import * as fs from "fs/promises";
import type { ChangeReport } from "./messages";

interface FileChange {
  file: string;
  shown: string;
  /** Null when the agent created the file. */
  before: string | null;
  after: string;
}

export interface UndoResult {
  restored: string[];
  skipped: string[];
}

/**
 * Records what Agent changes during one reply, so the reply can report it from
 * facts and be undone. It tracks the file tools only: a shell command can change
 * anything, so commands are counted but can't be undone.
 */
export class ChangeJournal {
  private readonly changes = new Map<string, FileChange>();
  private commands = 0;
  private failedCommands = 0;

  recordFile(file: string, shown: string, before: string | null, after: string): void {
    const earlier = this.changes.get(file);
    this.changes.set(file, { file, shown, before: earlier ? earlier.before : before, after });
  }

  recordCommand(succeeded: boolean): void {
    this.commands += 1;
    this.failedCommands += succeeded ? 0 : 1;
  }

  get hasFileChanges(): boolean {
    return this.changes.size > 0;
  }

  report(): ChangeReport {
    const all = [...this.changes.values()];
    return {
      created: all.filter((change) => change.before === null).map((change) => change.shown),
      edited: all.filter((change) => change.before !== null).map((change) => change.shown),
      commands: this.commands,
      failedCommands: this.failedCommands,
    };
  }

  /** Puts files back, but skips any that changed since, so newer work is never lost. */
  async undo(): Promise<UndoResult> {
    const result: UndoResult = { restored: [], skipped: [] };
    for (const change of this.changes.values()) {
      const current = await fs.readFile(change.file, "utf8").catch(() => undefined);
      if (current !== change.after) {
        result.skipped.push(change.shown);
      } else if (change.before === null) {
        await fs.rm(change.file);
        result.restored.push(change.shown);
      } else {
        await fs.writeFile(change.file, change.before);
        result.restored.push(change.shown);
      }
    }
    this.changes.clear();
    return result;
  }
}
