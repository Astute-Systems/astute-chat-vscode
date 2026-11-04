import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ChangeJournal } from "../changeJournal";

const folder = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "astute-journal-"));

test("reports what changed, from what the tools really did", () => {
  const journal = new ChangeJournal();
  journal.recordFile("/w/a.c", "a.c", null, "new");
  journal.recordFile("/w/b.c", "b.c", "old", "newer");
  journal.recordCommand(true);
  journal.recordCommand(false);
  assert.deepEqual(journal.report(), { created: ["a.c"], edited: ["b.c"], commands: 2, failedCommands: 1 });
});

test("undo restores edits and removes created files", async () => {
  const root = folder();
  const edited = path.join(root, "a.c");
  const created = path.join(root, "b.c");
  fs.writeFileSync(edited, "int add;");
  fs.writeFileSync(created, "new file");
  const journal = new ChangeJournal();
  journal.recordFile(edited, "a.c", "original", "first");
  journal.recordFile(edited, "a.c", "first", "int add;");
  journal.recordFile(created, "b.c", null, "new file");
  assert.deepEqual(await journal.undo(), { restored: ["a.c", "b.c"], skipped: [] });
  assert.equal(fs.readFileSync(edited, "utf8"), "original");
  assert.ok(!fs.existsSync(created));
  assert.equal(journal.hasFileChanges, false);
});

test("undo never overwrites newer work", async () => {
  const root = folder();
  const file = path.join(root, "a.c");
  fs.writeFileSync(file, "the user changed this");
  const journal = new ChangeJournal();
  journal.recordFile(file, "a.c", "original", "agent text");
  journal.recordFile(path.join(root, "gone.c"), "gone.c", "original", "agent text");
  assert.deepEqual(await journal.undo(), { restored: [], skipped: ["a.c", "gone.c"] });
  assert.equal(fs.readFileSync(file, "utf8"), "the user changed this");
});
