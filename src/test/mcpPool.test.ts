import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { McpServerConfig } from "../mcpClient";
import { MAX_TOOLS, McpLog, McpPool, shareTools } from "../mcpPool";

/** A real child process with TOOLS tools. A call to "die" ends it. */
const SERVER = `
const readline = require("readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} } } });
  } else if (message.method === "tools/list") {
    const tools = Array.from({ length: Number(process.env.TOOLS) }, (_, index) => ({ name: "tool" + index }));
    send({ id: message.id, result: { tools: [...tools, { name: "die" }] } });
  } else if (message.method === "tools/call") {
    if (message.params.name === "die") {
      process.exit(1);
    }
    send({ id: message.id, result: { content: [{ type: "text", text: "pid " + process.pid }] } });
  }
});
`;

const quiet: McpLog = { info() {}, warn() {}, error() {}, debug() {} };
const server = (tools: number): McpServerConfig => ({ command: process.execPath, args: ["-e", SERVER], env: { TOOLS: String(tools) } });
const pool = (servers: Record<string, McpServerConfig>, retryAfterMs?: number): McpPool => new McpPool(() => servers, () => undefined, quiet, retryAfterMs);
const waitUntil = async (check: () => Promise<boolean>): Promise<void> => {
  for (let tries = 0; tries < 100 && !(await check()); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("shares the limit evenly between servers", () => {
  const { kept, skipped } = shareTools([["a1", "a2", "a3", "a4"], ["b1"], ["c1", "c2"]], 5);
  assert.deepEqual(kept, ["a1", "b1", "c1", "a2", "c2"]);
  assert.deepEqual(skipped, ["a3", "a4"]);
});

test("a large server can't crowd out a small one", async (t) => {
  const mcp = pool({ large: server(30), small: server(1) });
  t.after(() => mcp.stop());
  const { tools, skipped, failed } = await mcp.definitions();
  assert.equal(tools.length, MAX_TOOLS);
  assert.equal(failed.length, 0);
  assert.ok(tools.some((tool) => tool.function.name === "mcp_small_tool0"));
  assert.equal(skipped.length, 33 - MAX_TOOLS);
  assert.deepEqual((await mcp.definitions()).skipped, [], "the same tools are only reported once");
});

test("restarts a server that stopped", async (t) => {
  const mcp = pool({ demo: server(1) });
  t.after(() => mcp.stop());
  await mcp.definitions();
  const first = await mcp.call("mcp_demo_tool0", {});
  await assert.rejects(mcp.call("mcp_demo_die", {}));
  const second = await mcp.call("mcp_demo_tool0", {});
  assert.match(second, /^pid /);
  assert.notEqual(first, second);
});

test("tries a failed server again, but not on every request", async (t) => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "astute-mcp-")), "ready");
  const flaky: McpServerConfig = { command: process.execPath, args: ["-e", `if (!require("fs").existsSync(${JSON.stringify(marker)})) process.exit(1);${SERVER}`], env: { TOOLS: "1" } };
  const mcp = pool({ flaky }, 150);
  t.after(() => mcp.stop());
  assert.deepEqual((await mcp.definitions()).failed, ["flaky"]);
  assert.deepEqual((await mcp.definitions()).failed, [], "it waits before trying again");
  fs.writeFileSync(marker, "");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await waitUntil(async () => (await mcp.definitions()).tools.length > 0);
  assert.ok(mcp.has("mcp_flaky_tool0"));
});

test("leaves running servers alone", async (t) => {
  const mcp = pool({ demo: server(1) });
  t.after(() => mcp.stop());
  await mcp.definitions();
  const first = await mcp.call("mcp_demo_tool0", {});
  await mcp.definitions();
  assert.equal(await mcp.call("mcp_demo_tool0", {}), first);
});
