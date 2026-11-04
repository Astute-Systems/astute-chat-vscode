import * as assert from "node:assert/strict";
import { test } from "node:test";
import { chunkFile, rankChunks, searchWords } from "../codeSearch";

test("splits names and matches word forms", () => {
  assert.deepEqual(searchWords("runChat max_retries HTTPServer"), ["run", "chat", "max", "retry", "http", "server"]);
  assert.deepEqual(searchWords("retries"), searchWords("retry"));
  assert.deepEqual(searchWords("the and of"), []);
});

test("splits files into overlapping chunks with line numbers", () => {
  const text = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
  const chunks = chunkFile("a.c", text);
  assert.deepEqual(chunks.map((chunk) => chunk.startLine), [1, 31, 61]);
  assert.ok(chunks[0].text.endsWith("line 40"));
  assert.deepEqual(chunkFile("empty.c", "\n\n"), []);
});

test("finds code from a plain description", () => {
  const chunks = [
    { file: "src/retry.ts", startLine: 1, text: "function sendWithRetry() { for (let attempt = 0; attempt < 3; attempt++) { reconnect(); } }" },
    { file: "src/ui.ts", startLine: 1, text: "function renderButton() { button.textContent = 'Send'; }" },
    { file: "src/config.ts", startLine: 1, text: "export function readSettings() { return config.get('host'); }" },
  ];
  assert.equal(rankChunks(chunks, "where do we retry when sending fails")[0].file, "src/retry.ts");
  assert.equal(rankChunks(chunks, "read the host setting")[0].file, "src/config.ts");
  assert.deepEqual(rankChunks(chunks, "quantum entanglement"), []);
  assert.deepEqual(rankChunks([], "anything"), []);
});

test("shows each file once", () => {
  const chunks = [1, 31].map((startLine) => ({ file: "a.c", startLine, text: "retry retry" }));
  assert.equal(rankChunks([...chunks, { file: "b.c", startLine: 1, text: "retry" }], "retry").length, 2);
});
