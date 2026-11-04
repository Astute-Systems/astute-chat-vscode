import * as assert from "node:assert/strict";
import { test } from "node:test";
import { NdjsonParser, OllamaClient, OllamaError } from "../ollamaClient";
import { line, startMock } from "./mockOllama";

const request = { model: "tiny:1b", messages: [{ role: "user" as const, content: "hi" }] };

test("the parser handles lines and UTF-8 split across chunks", () => {
  const parser = new NdjsonParser();
  const bytes = Buffer.from(line({ text: "é" }) + line({ n: 2 }));
  const split = bytes.indexOf(0xa9);
  assert.deepEqual(parser.push(bytes.subarray(0, split)), []);
  assert.deepEqual(parser.push(bytes.subarray(split)), [{ text: "é" }, { n: 2 }]);
  assert.deepEqual(parser.flush(), []);
});

test("streams thinking and content, then reads final usage", async (t) => {
  const mock = await startMock((_req, res) => {
    res.write(line({ message: { thinking: "hm" }, done: false }));
    res.write(line({ message: { content: "O" }, done: false }));
    res.end(line({ message: { content: "K" }, done: true, done_reason: "stop", prompt_eval_count: 16, eval_count: 3, eval_duration: 1e9 }));
  });
  t.after(() => mock.close());
  const thinking: string[] = [];
  const content: string[] = [];
  const outcome = await new OllamaClient(mock.url).chat(request, { onThinking: (x) => thinking.push(x), onContent: (x) => content.push(x) });
  assert.deepEqual(thinking, ["hm"]);
  assert.deepEqual(content, ["O", "K"]);
  assert.equal(outcome.content, "OK");
  assert.deepEqual(outcome.usage, { promptTokens: 16, outputTokens: 3, evalDurationNs: 1e9, doneReason: "stop" });
  assert.equal(mock.requests.at(-1)?.body.stream, true);
});

test("classifies a missing model", async (t) => {
  const mock = await startMock((_req, res) => {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "model 'llama3.1' not found" }));
  });
  t.after(() => mock.close());
  await assert.rejects(new OllamaClient(mock.url).chat(request, {}), (error: OllamaError) => error.kind === "model-not-found");
});

test("classifies out-of-memory errors, including mid-stream", async (t) => {
  const mock = await startMock((_req, res) => {
    res.write(line({ error: "model requires more system memory (9 GiB) than is available" }));
    res.end();
  });
  t.after(() => mock.close());
  await assert.rejects(new OllamaClient(mock.url).chat(request, {}), (error: OllamaError) => error.kind === "out-of-memory");
});

test("reports a refused connection", async () => {
  const mock = await startMock(() => undefined);
  await mock.close();
  await assert.rejects(new OllamaClient(mock.url).listModels(), (error: OllamaError) => error.kind === "connection");
  await assert.rejects(new OllamaClient(mock.url).chat(request, {}), (error: OllamaError) => error.kind === "connection");
});

test("Stop cancels a stream that is in progress", async (t) => {
  const mock = await startMock((_req, res) => res.write(line({ message: { content: "partial" }, done: false })));
  t.after(() => mock.close());
  const abort = new AbortController();
  const pending = new OllamaClient(mock.url).chat(request, { onContent: () => abort.abort() }, { signal: abort.signal });
  await assert.rejects(pending, (error: OllamaError) => error.kind === "cancelled");
});

test("times out only when the server goes quiet", async (t) => {
  const mock = await startMock((_req, res) => {
    res.write(line({ message: { content: "a" }, done: false }));
    const timer = setTimeout(() => res.write(line({ message: { content: "b" }, done: false })), 60);
    setTimeout(() => res.write(line({ message: { content: "c" }, done: false })), 120);
    timer.unref();
  });
  t.after(() => mock.close());
  const content: string[] = [];
  await assert.rejects(new OllamaClient(mock.url).chat(request, { onContent: (x) => content.push(x) }, { idleTimeoutMs: 100 }), (error: OllamaError) => error.kind === "timeout");
  assert.deepEqual(content, ["a", "b", "c"]);
});

test("reports a stream that ends early", async (t) => {
  const mock = await startMock((_req, res) => res.end(line({ message: { content: "a" }, done: false })));
  t.after(() => mock.close());
  await assert.rejects(new OllamaClient(mock.url).chat(request, {}), (error: OllamaError) => error.kind === "server");
});

test("reads capabilities and the context limit", async (t) => {
  const mock = await startMock(() => undefined);
  t.after(() => mock.close());
  assert.deepEqual(await new OllamaClient(mock.url).showModel("tiny:1b"), { capabilities: ["completion", "tools", "thinking"], contextLength: 4096 });
});
