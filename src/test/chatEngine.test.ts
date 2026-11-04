import * as assert from "node:assert/strict";
import { test } from "node:test";
import { chooseToolModel, commandFailed, EngineEvents, fitToContext, resolveModel, runChat, ToolRunner } from "../chatEngine";
import { ChatMessage, OllamaClient } from "../ollamaClient";
import { line, startMock } from "./mockOllama";

const installed = [{ name: "llama3.1:8b", size: 50 }, { name: "gemma3:4b", size: 30 }, { name: "qwen3:8b", size: 60 }];

function recorder(): EngineEvents & { statuses: string[]; notices: string[]; tools: string[]; text: string } {
  const log = {
    statuses: [] as string[],
    notices: [] as string[],
    tools: [] as string[],
    text: "",
    onStatus: (text: string) => void log.statuses.push(text),
    onThinking: () => undefined,
    onContent: (text: string) => void (log.text += text),
    onTool: (text: string) => void log.tools.push(text),
    onNotice: (text: string) => void log.notices.push(text),
  };
  return log;
}

test("resolves the old llama3.1 default to the installed tag", () => {
  assert.deepEqual(resolveModel("llama3.1", installed), { name: "llama3.1:8b" });
  assert.deepEqual(resolveModel("qwen3:8b", installed), { name: "qwen3:8b" });
  assert.deepEqual(resolveModel("", installed), { name: "gemma3:4b", reason: "default" });
  assert.deepEqual(resolveModel("mixtral", installed), { reason: "missing" });
  assert.deepEqual(resolveModel("", []), { name: undefined, reason: "missing" });
});

test("drops the oldest turns and keeps the system prompt and new question", () => {
  const big = "x".repeat(4000);
  const messages: ChatMessage[] = [
    { role: "system", content: "rules" },
    { role: "user", content: big },
    { role: "assistant", content: big },
    { role: "user", content: "newest" },
  ];
  const fitted = fitToContext(messages, 1000);
  assert.equal(fitted.dropped, 2);
  assert.deepEqual(fitted.messages.map((m) => m.content), ["rules", "newest"]);
});

test("keeps the request and paired tool results during a long Agent run", () => {
  const big = "x".repeat(12000);
  const call = (name: string): ChatMessage => ({ role: "assistant", content: "", tool_calls: [{ function: { name, arguments: {} } }] });
  const messages: ChatMessage[] = [
    { role: "system", content: "rules" },
    { role: "user", content: `older question ${big}` },
    { role: "assistant", content: "older answer" },
    { role: "user", content: "Build the I2C driver" },
  ];
  for (const name of ["one", "two", "three", "four", "five"]) {
    messages.push(call(name), { role: "tool", tool_name: name, content: big });
  }
  const { messages: kept } = fitToContext(messages, 8192, 3);
  assert.equal(kept[0].role, "system");
  assert.ok(kept.some((message) => message.content === "Build the I2C driver"), "the request survives");
  assert.ok(!kept.some((message) => message.content.startsWith("older question")), "old chat goes when shortening isn't enough");
  assert.equal(kept.at(-1)?.tool_name, "five", "the newest result survives");
  assert.equal(kept.at(-1)?.content, big, "the newest result stays whole");
  kept.forEach((message, index) => {
    if (message.role === "tool") {
      const before = kept[index - 1];
      assert.ok(before.role === "tool" || before.tool_calls?.length, "each result follows a call");
    }
  });
  assert.ok(kept.reduce((total, message) => total + message.content.length, 0) / 4 < 8192 * 0.8);
});

test("removes old questions together with their replies", () => {
  const big = "x".repeat(16000);
  const messages: ChatMessage[] = [
    { role: "system", content: "rules" },
    { role: "user", content: big },
    { role: "assistant", content: "stray" },
    { role: "user", content: big },
    { role: "assistant", content: "kept" },
    { role: "user", content: "newest" },
  ];
  const { messages: kept } = fitToContext(messages, 8192);
  assert.deepEqual(kept.map((message) => message.role), ["system", "user", "assistant", "user"]);
  assert.ok(!kept.some((message) => message.content === "stray"));
});

test("leaves a prompt that already fits untouched", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "rules" }, { role: "user", content: "hi" }];
  assert.deepEqual(fitToContext(messages, 8192), { messages, dropped: 0 });
});

test("runs a tool round in the documented message order", async (t) => {
  let round = 0;
  const mock = await startMock((_req, res) => {
    round += 1;
    if (round === 1) {
      res.end(line({ message: { content: "", tool_calls: [{ type: "function", function: { name: "read_file", arguments: { path: "a.ts" } } }] }, done: true, prompt_eval_count: 10, eval_count: 4, eval_duration: 1e9 }));
    } else {
      res.end(line({ message: { content: "It exports main." }, done: true, prompt_eval_count: 20, eval_count: 5, eval_duration: 1e9 }));
    }
  });
  t.after(() => mock.close());

  const tools: ToolRunner = { definitions: [{ type: "function", function: { name: "read_file", description: "", parameters: {} } }], run: async () => "export function main() {}" };
  const events = recorder();
  const result = await runChat({ client: new OllamaClient(mock.url), model: "tiny:1b", messages: [{ role: "user", content: "what?" }], contextLimit: 4096, temperature: 0, keepAlive: "5m", idleTimeoutMs: 1000, think: false, tools, events });

  const second = mock.requests.filter((r) => r.path === "/api/chat")[1].body.messages as ChatMessage[];
  assert.equal(second[1].role, "assistant");
  assert.equal(second[1].tool_calls?.[0].function.name, "read_file");
  assert.deepEqual({ role: second[2].role, tool_name: second[2].tool_name, content: second[2].content }, { role: "tool", tool_name: "read_file", content: "export function main() {}" });
  assert.equal(result.content, "It exports main.");
  assert.match(result.summary, /^↑20 ↓9 · 4\.5 t\/s/);
  assert.deepEqual(events.tools, ['read_file({"path":"a.ts"})']);
  assert.equal(mock.requests.find((r) => r.path === "/api/chat")?.body.options.num_ctx, 4096);
});

test("stops offering tools after the round limit", async (t) => {
  const mock = await startMock((req, res) => {
    const call = req.body.tools ? [{ function: { name: "list_files", arguments: {} } }] : undefined;
    res.end(line({ message: { content: call ? "" : "done", tool_calls: call }, done: true, eval_count: 1 }));
  });
  t.after(() => mock.close());
  const tools: ToolRunner = { definitions: [{ type: "function", function: { name: "list_files", description: "", parameters: {} } }], run: async () => "none" };
  const result = await runChat({ client: new OllamaClient(mock.url), model: "tiny:1b", messages: [{ role: "user", content: "go" }], contextLimit: 4096, temperature: 0, keepAlive: "5m", idleTimeoutMs: 1000, think: false, tools, events: recorder() });
  assert.equal(result.content, "done");
  assert.equal(mock.requests.filter((r) => r.path === "/api/chat").length, 7);
});

test("keeps partial text when stopped, and warns when cut off", async (t) => {
  const mock = await startMock((_req, res) => res.end(line({ message: { content: "cut" }, done: true, done_reason: "length", eval_count: 1 })));
  t.after(() => mock.close());
  const events = recorder();
  await runChat({ client: new OllamaClient(mock.url), model: "tiny:1b", messages: [{ role: "user", content: "go" }], contextLimit: 4096, temperature: 0, keepAlive: "5m", idleTimeoutMs: 1000, think: false, events });
  assert.match(events.notices[0], /cut off/);

  const stopMock = await startMock((_req, res) => res.write(line({ message: { content: "partial" }, done: false })));
  t.after(() => stopMock.close());
  const abort = new AbortController();
  const stopEvents = recorder();
  stopEvents.onContent = () => abort.abort();
  const stopped = await runChat({ client: new OllamaClient(stopMock.url), model: "tiny:1b", messages: [{ role: "user", content: "go" }], contextLimit: 4096, temperature: 0, keepAlive: "5m", idleTimeoutMs: 1000, think: false, signal: abort.signal, events: stopEvents });
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.content, "partial");
  assert.match(stopped.summary, /^Stopped/);
});

test("Stop prevents queued tools from running", async (t) => {
  const mock = await startMock((_req, res) =>
    res.end(line({ message: { content: "", tool_calls: [{ function: { name: "first", arguments: {} } }, { function: { name: "second", arguments: {} } }] }, done: true, eval_count: 1 })),
  );
  t.after(() => mock.close());
  const abort = new AbortController();
  const ran: string[] = [];
  const tools: ToolRunner = {
    definitions: [],
    run: async (call) => {
      ran.push(call.function.name);
      abort.abort();
      return "ok";
    },
  };
  const result = await runChat({ client: new OllamaClient(mock.url), model: "tiny:1b", messages: [{ role: "user", content: "go" }], contextLimit: 4096, temperature: 0, keepAlive: "5m", idleTimeoutMs: 1000, think: false, tools, signal: abort.signal, events: recorder() });
  assert.deepEqual(ran, ["first"]);
  assert.equal(result.cancelled, true);
});

const retryRequest = (url: string, events: EngineEvents, tools: ToolRunner) => ({
  client: new OllamaClient(url),
  model: "tiny:1b",
  messages: [{ role: "user" as const, content: "Build library" }],
  contextLimit: 4096,
  temperature: 0,
  keepAlive: "5m",
  idleTimeoutMs: 1000,
  think: false,
  tools,
  retryWithoutTools: "Call a tool now.",
  events,
});
const noopTools: ToolRunner = { definitions: [], run: async () => "done" };

test("retries once when Agent replies without acting", async (t) => {
  let round = 0;
  const mock = await startMock((_req, res) => {
    round += 1;
    const call = round === 2 ? [{ function: { name: "write_file", arguments: {} } }] : undefined;
    res.end(line({ message: { content: round === 1 ? "Here is how to build it." : round === 3 ? "Built." : "", tool_calls: call }, done: true, eval_count: 1 }));
  });
  t.after(() => mock.close());
  const events = recorder();
  const result = await runChat(retryRequest(mock.url, events, noopTools));
  const retry = mock.requests.filter((r) => r.path === "/api/chat")[1].body.messages as ChatMessage[];
  assert.equal(retry.at(-1)?.content, "Call a tool now.");
  assert.equal(events.tools.length, 1);
  assert.match(result.content, /Built\.$/);
  assert.equal(events.notices.length, 1);
});

test("says so when Agent changed nothing, and retries only once", async (t) => {
  const mock = await startMock((_req, res) => res.end(line({ message: { content: "Steps to build." }, done: true, eval_count: 1 })));
  t.after(() => mock.close());
  const events = recorder();
  await runChat(retryRequest(mock.url, events, noopTools));
  assert.equal(mock.requests.filter((r) => r.path === "/api/chat").length, 2);
  assert.match(events.notices.at(-1) ?? "", /nothing in the workspace changed/);
});

test("accepts a question instead of retrying", async (t) => {
  const mock = await startMock((_req, res) => res.end(line({ message: { content: "Which language should the library use?" }, done: true, eval_count: 1 })));
  t.after(() => mock.close());
  const events = recorder();
  await runChat(retryRequest(mock.url, events, noopTools));
  assert.equal(mock.requests.filter((r) => r.path === "/api/chat").length, 1);
  assert.deepEqual(events.notices, []);
});

test("chooses a model for Agent mode", () => {
  const models = [
    { name: "vision", size: 1, capabilities: ["completion", "vision"] },
    { name: "small", size: 2, capabilities: ["completion", "tools"] },
    { name: "better", size: 5, capabilities: ["completion", "tools", "thinking"] },
    { name: "huge", size: 9, capabilities: ["completion", "tools", "thinking"] },
  ];
  assert.equal(chooseToolModel(models), "better");
  assert.equal(chooseToolModel(models.slice(0, 2)), "small");
  assert.equal(chooseToolModel(models.slice(0, 1)), undefined);
});

test("recognises a failed command from its status only", () => {
  assert.equal(commandFailed("Exit code 2\nmake: *** Error"), true);
  assert.equal(commandFailed("Timed out\n"), true);
  assert.equal(commandFailed("Exit code 0\nExit code 2"), false);
  assert.equal(commandFailed("Refused: x is empty\nExit code 0\nok"), false);
  assert.equal(commandFailed("The user denied this command."), false);
});

const buildTools = (results: string[]): ToolRunner => ({ definitions: [], run: async () => results.shift() ?? "Exit code 0\nok" });

test("sends a failed build back to be fixed, then finishes", async (t) => {
  let round = 0;
  const mock = await startMock((_req, res) => {
    round += 1;
    const replies = [{ tool_calls: [{ function: { name: "run_command", arguments: {} } }] }, { content: "All done!" }, { tool_calls: [{ function: { name: "run_command", arguments: {} } }] }, { content: "Fixed." }];
    res.end(line({ message: { content: "", ...replies[round - 1] }, done: true, eval_count: 1 }));
  });
  t.after(() => mock.close());
  const events = recorder();
  const result = await runChat({ ...retryRequest(mock.url, events, buildTools(["Exit code 2\nerror"])), fixFailures: "Fix it." });
  assert.equal(round, 4);
  assert.equal(mock.requests.filter((r) => r.path === "/api/chat")[2].body.messages.at(-1).content, "Fix it.\n\nIt printed:\nerror");
  assert.match(result.content, /Fixed\.$/);
  assert.deepEqual(events.notices, []);
});

test("stops after three fixes and says the command still fails", async (t) => {
  let round = 0;
  const mock = await startMock((_req, res) => {
    round += 1;
    const call = round % 2 === 1;
    res.end(line({ message: { content: call ? "" : "Good job!", tool_calls: call ? [{ function: { name: "run_command", arguments: {} } }] : undefined }, done: true, eval_count: 1 }));
  });
  t.after(() => mock.close());
  const events = recorder();
  await runChat({ ...retryRequest(mock.url, events, { definitions: [], run: async () => "Exit code 1\nerror" }), fixFailures: "Fix it." });
  assert.equal(round, 8);
  assert.match(events.notices.at(-1) ?? "", /still failed when this reply ended\. It printed: error/);
});

test("a question doesn't hide a failed command", async (t) => {
  let round = 0;
  const mock = await startMock((_req, res) => {
    round += 1;
    const replies = [{ tool_calls: [{ function: { name: "run_command", arguments: {} } }] }, { content: "I can't run commands. What should I do?" }, { content: "It needs the cloud tag." }];
    res.end(line({ message: { content: "", ...replies[Math.min(round, 3) - 1] }, done: true, eval_count: 1 }));
  });
  t.after(() => mock.close());
  const events = recorder();
  const error = 'Error: file does not exist\n"glm-5.3:cloud" is available as a cloud model.';
  await runChat({ ...retryRequest(mock.url, events, { definitions: [], run: async () => `Exit code 1\n${error}` }), fixFailures: "Fix it." });
  const fix = mock.requests.filter((r) => r.path === "/api/chat")[2].body.messages.at(-1).content;
  assert.match(fix, /glm-5\.3:cloud/, "the model is told the real error");
  assert.match(events.notices.at(-1) ?? "", /It printed: Error: file does not exist/, "so is the user");
});

test("a later success clears a failed command", async (t) => {
  let round = 0;
  const mock = await startMock((_req, res) => {
    round += 1;
    const call = round <= 2;
    res.end(line({ message: { content: call ? "" : "Done.", tool_calls: call ? [{ function: { name: "run_command", arguments: {} } }] : undefined }, done: true, eval_count: 1 }));
  });
  t.after(() => mock.close());
  const events = recorder();
  const results = ["Exit code 1\nerror", "Exit code 0\nok"];
  await runChat({ ...retryRequest(mock.url, events, { definitions: [], run: async () => results.shift() as string }), fixFailures: "Fix it." });
  assert.equal(round, 3);
  assert.deepEqual(events.notices, []);
});

test("does not retry a normal final reply after tools ran", async (t) => {
  let round = 0;
  const mock = await startMock((_req, res) => {
    round += 1;
    res.end(line({ message: { content: round === 1 ? "" : "Done.", tool_calls: round === 1 ? [{ function: { name: "x", arguments: {} } }] : undefined }, done: true, eval_count: 1 }));
  });
  t.after(() => mock.close());
  const events = recorder();
  await runChat(retryRequest(mock.url, events, noopTools));
  assert.equal(round, 2);
  assert.deepEqual(events.notices, []);
});

test("automatic choices never pick a cloud model", () => {
  const models = [{ name: "glm-5.3:cloud", size: 293, remote: true }, { name: "gemma3:4b", size: 3000 }, { name: "qwen3:8b", size: 5000 }];
  assert.deepEqual(resolveModel("", models), { name: "gemma3:4b", reason: "default" });
  assert.deepEqual(resolveModel("", [models[0]]), { name: undefined, reason: "missing" });
  assert.equal(resolveModel("glm-5.3:cloud", models).name, "glm-5.3:cloud", "a model the user chose is still used");
  const withTools = models.map((model) => ({ ...model, capabilities: ["tools", "thinking"] }));
  assert.equal(chooseToolModel(withTools), "gemma3:4b");
  assert.equal(chooseToolModel(withTools.slice(0, 1)), undefined);
});
