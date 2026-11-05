import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runShell } from "../shell";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("captures output and exit codes", async () => {
  const result = await runShell("echo out; echo err >&2; exit 3", os.tmpdir(), 5000);
  assert.equal(result.exitCode, 3);
  assert.match(result.output, /out/);
  assert.match(result.output, /err/);
});

test("Stop also ends processes the command started", async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "astute-")), "still-running");
  const abort = new AbortController();
  const pending = runShell(`(sleep 1; touch ${marker}) & wait`, os.tmpdir(), 10000, abort.signal);
  await delay(200);
  abort.abort();
  const started = Date.now();
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.ok(Date.now() - started < 3000);
  await delay(1100);
  assert.equal(fs.existsSync(marker), false);
});

test("times out", async () => {
  const result = await runShell("sleep 5", os.tmpdir(), 100);
  assert.equal(result.timedOut, true);
});

test("very long output keeps its end, where errors are", async () => {
  const result = await runShell("yes noise | head -c 300000; echo final-error", os.tmpdir(), 10000);
  assert.ok(result.output.length <= 200000);
  assert.match(result.output, /final-error\s*$/);
});
