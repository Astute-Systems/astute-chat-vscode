import * as assert from "node:assert/strict";
import { test } from "node:test";
import { findFileReferences } from "../fileLinks";

const paths = (text: string): string[] => findFileReferences(text).map((reference) => reference.path);

test("finds file names and paths in text", () => {
  assert.deepEqual(paths("Edit src/foo.ts and libmylib.a, then see README.md."), ["src/foo.ts", "libmylib.a", "README.md"]);
  assert.deepEqual(paths("Open ./a/b.c or ../c.h or /home/me/d.py"), ["./a/b.c", "../c.h", "/home/me/d.py"]);
  assert.deepEqual(paths("(add.c), .gitignore and the Makefile"), ["add.c", "Makefile"]);
  assert.deepEqual(paths("package-lock.json @types/node.d.ts"), ["package-lock.json", "@types/node.d.ts"]);
});

test("reads line numbers", () => {
  const [one] = findFileReferences("at src/a.ts:42:7 now");
  assert.deepEqual({ path: one.path, line: one.line, column: one.column }, { path: "src/a.ts", line: 42, column: 7 });
  assert.equal(findFileReferences("src/a.ts:42-51")[0].line, 42);
  assert.equal(findFileReferences("src/a.ts#L9-L12")[0].line, 9);
});

test("gives the exact span of the whole reference", () => {
  const text = "see src/a.ts:4.";
  const [reference] = findFileReferences(text);
  assert.equal(text.slice(reference.start, reference.end), "src/a.ts:4");
});

test("ignores text that cannot be a file", () => {
  assert.deepEqual(paths("no files here at all"), []);
  assert.deepEqual(paths("https://example.com/a/b.html"), []);
  assert.deepEqual(paths("me@example.com"), []);
});
