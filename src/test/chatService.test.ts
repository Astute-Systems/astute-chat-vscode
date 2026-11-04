import * as assert from "node:assert/strict";
import { test } from "node:test";
import { startMock } from "./mockOllama";
import type { ChatMessage } from "../ollamaClient";

// chatService.ts needs the vscode module, which only exists inside VS Code.
const settings = new Map<string, unknown>();
const Module = require("node:module") as { _load(request: string, ...rest: unknown[]): unknown };
const load = Module._load;
const vscodeStub = {
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  env: { shell: "/bin/bash" },
  window: { activeTextEditor: undefined },
  workspace: {
    workspaceFolders: undefined,
    isTrusted: true,
    findFiles: async () => [],
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => settings.get(key) ?? fallback,
      inspect: (key: string) => ({ globalValue: settings.get(key) }),
    }),
  },
};
Module._load = function (request: string, ...rest: unknown[]) {
  return request === "vscode" ? vscodeStub : load.call(this, request, ...rest);
};
const { ChatService } = require("../chatService") as typeof import("../chatService");
Module._load = load;

const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const events = { onStatus: () => undefined, onThinking: () => undefined, onContent: () => undefined, onTool: () => undefined, onNotice: () => undefined };

async function withServer(check: (service: InstanceType<typeof ChatService>, sent: () => any[]) => Promise<void>, replies: string[] = []): Promise<void> {
  const mock = await startMock((_request, response) => {
    response.end(`${JSON.stringify({ message: { content: replies.shift() ?? "answer" }, done: true, prompt_eval_count: 900, eval_count: 5, done_reason: "stop" })}\n`);
  });
  const url = new URL(mock.url);
  settings.set("server.host", url.hostname);
  settings.set("server.port", Number(url.port));
  settings.set("model", "tiny:1b");
  settings.set("numCtx", 8192);
  try {
    await check(new ChatService(log as never), () => mock.requests.filter((request) => request.path === "/api/chat").map((request) => request.body));
  } finally {
    settings.clear();
    await mock.close();
  }
}

test("tells prepareHistory the size of the rest of the prompt and the model's real window", async () => {
  await withServer(async (service) => {
    let budget: { model: string; contextLimit: number; reservedTokens: number } | undefined;
    await service.runTurn({
      prompt: "y".repeat(4000),
      events,
      prepareHistory: async (given) => {
        budget = given;
        return { history: [] };
      },
    });
    assert.equal(budget?.model, "tiny:1b");
    assert.equal(budget?.contextLimit, 4096, "capped to the model's limit");
    assert.ok((budget?.reservedTokens ?? 0) > 1000, "counts the request and system prompt");
  });
});

test("puts the summary at the end of the system prompt and recent work with the request", async () => {
  await withServer(async (service, sent) => {
    const history: ChatMessage[] = [{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }];
    await service.runTurn({ prompt: "now", events, prepareHistory: async () => ({ history, systemSection: "SUMMARY", requestNote: "\n\nRECENT" }) });
    const { messages } = sent()[0];
    assert.equal(messages[0].role, "system");
    assert.ok(messages[0].content.endsWith("SUMMARY"));
    assert.deepEqual(messages.slice(1, 3), history);
    assert.equal(messages[3].content, "now\n\nRECENT");
  });
});

test("callers without prepareHistory send their own history", async () => {
  await withServer(async (service, sent) => {
    await service.runTurn({ prompt: "now", events, history: [{ role: "user", content: "earlier" }] });
    assert.equal(sent()[0].messages[1].content, "earlier");
  });
});

test("summarises with the model Agent uses, inside its real window", async () => {
  await withServer(async (service, sent) => {
    settings.set("agentModel", "big:8b");
    const target = await service.summaryTarget("agent");
    assert.deepEqual(target, { model: "big:8b", contextLimit: 4096, usableLimit: 4096 });
    await service.summarise([{ role: "user", content: "z".repeat(100000) }], "- earlier", target);
    const [request] = sent();
    assert.equal(request.model, "big:8b");
    assert.equal(request.options.num_ctx, 4096);
    assert.match(request.messages[0].content, /Earlier notes:\n- earlier/);
    assert.ok(request.messages[0].content.length / 4 <= 4096 * 0.75, "the input fits the window");
  });
});

test("plans with less room once a model turns out to use more tokens", async () => {
  await withServer(async (service) => {
    await service.runTurn({ prompt: "x".repeat(1200), events });
    const { contextLimit, usableLimit } = await service.summaryTarget("ask");
    assert.equal(contextLimit, 4096, "num_ctx doesn't change");
    assert.ok(usableLimit < 4096);
  });
});

test("Plan sends a reply with no plan shape back to the model", async () => {
  const good = "## Goal\nx\n\n## Files\n- a.ts\n\n## Steps\n1. y\n\n## Verify\nz\n\n## Risks\nNone\n\n## Open questions\nNone";
  await withServer(async (service, sent) => {
    const result = await service.runTurn({ prompt: "plan it", mode: "plan", events });
    assert.equal(result.content, good);
    assert.equal(sent().length, 2);
    assert.match(sent()[1].messages.at(-1).content, /headings are missing/);
  }, ["Just edit it.", good]);
});

test("Ask replies aren't checked as plans", async () => {
  await withServer(async (service, sent) => {
    await service.runTurn({ prompt: "what is this", mode: "ask", events });
    assert.equal(sent().length, 1);
  }, ["It's a chat client."]);
});
