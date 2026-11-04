import * as assert from "node:assert/strict";
import { test } from "node:test";
import { mentionAt, rankFiles, withFolders } from "../filePicker";
import { stripTerminalCodes } from "../terminalCodes";

const files = ["src/main.c", "src/ollamaClient.ts", "test/Makefile", "README.md", "src/drivers/main_bus.c"];

test("offers folders as well as files", () => {
  assert.deepEqual(withFolders(["src/a/b.c"]), ["src/", "src/a/", "src/a/b.c"]);
});

test("ranks exact names, then prefixes, then other matches", () => {
  assert.deepEqual(rankFiles(files, "main"), ["src/main.c", "src/drivers/main_bus.c"]);
  assert.equal(rankFiles(files, "client")[0], "src/ollamaClient.ts");
  assert.equal(rankFiles(files, "MAKE")[0], "test/Makefile");
  assert.equal(rankFiles(withFolders(files), "drivers")[0], "src/drivers/");
  assert.deepEqual(rankFiles(files, "nothing"), []);
  assert.equal(rankFiles(files, "", 2).length, 2);
});

test("finds an @ word at the cursor only", () => {
  assert.deepEqual(mentionAt("fix @src/ma", 11), { start: 4, query: "src/ma" });
  assert.deepEqual(mentionAt("@", 1), { start: 0, query: "" });
  assert.equal(mentionAt("me@example.com", 14), undefined);
  assert.equal(mentionAt("fix @src now", 12), undefined);
});

test("removes colour, title and shell integration codes", () => {
  assert.equal(stripTerminalCodes("\x1b[31merror\x1b[0m: bad\r\n"), "error: bad\n");
  assert.equal(stripTerminalCodes("\x1b]633;D;0\x07done"), "done");
  assert.equal(stripTerminalCodes("\x1b]0;title\x1b\\text"), "text");
});
