import * as assert from "node:assert/strict";
import { test } from "node:test";
import { McpConnection, resultText, toolName } from "../mcpClient";

/** A small MCP server, run as a real child process. */
const SERVER = `
const readline = require("readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  console.error("stderr is only logging");
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: process.env.MCP_VERSION || message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1" } } });
  } else if (message.method === "notifications/initialized") {
    send({ id: "server-ping", method: "ping" });
  } else if (message.method === "tools/list") {
    if (!message.params.cursor) {
      send({ id: message.id, result: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }], nextCursor: "page2" } });
    } else {
      send({ id: message.id, result: { tools: [{ name: "slow" }] } });
    }
  } else if (message.method === "tools/call") {
    if (message.params.name === "echo") {
      send({ id: message.id, result: { content: [{ type: "text", text: "you said " + message.params.arguments.text }] } });
    } else if (message.params.name === "bad") {
      send({ id: message.id, error: { code: -32602, message: "Unknown tool: bad" } });
    }
  }
});
`;

const connect = async (env: Record<string, string> = {}): Promise<McpConnection> => {
  const connection = new McpConnection({ command: process.execPath, args: ["-e", SERVER], env }, undefined);
  await connection.connect();
  return connection;
};

test("connects, follows pagination and calls a tool", async (t) => {
  const connection = await connect();
  t.after(() => connection.close());
  assert.deepEqual((await connection.listTools()).map((tool) => tool.name), ["echo", "slow"]);
  assert.equal(await connection.callTool("echo", { text: "hi" }), "you said hi");
});

test("reports protocol errors", async (t) => {
  const connection = await connect();
  t.after(() => connection.close());
  await assert.rejects(connection.callTool("bad", {}), /Unknown tool/);
});

test("Stop cancels a call that is waiting", async (t) => {
  const connection = await connect();
  t.after(() => connection.close());
  const abort = new AbortController();
  const pending = connection.callTool("slow", {}, abort.signal);
  abort.abort();
  await assert.rejects(pending, /Stopped/);
});

test("refuses a protocol version it doesn't know", async (t) => {
  const connection = new McpConnection({ command: process.execPath, args: ["-e", SERVER], env: { MCP_VERSION: "1.0.0" } }, undefined);
  t.after(() => connection.close());
  await assert.rejects(connection.connect(), /Unsupported/);
});

test("reports a server that can't start", async () => {
  const connection = new McpConnection({ command: "/nonexistent/astute-mcp" }, undefined);
  await assert.rejects(connection.connect());
});

test("makes tool names models accept", () => {
  assert.equal(toolName("my server", "get.file"), "mcp_my_server_get_file");
  assert.ok(toolName("s", "x".repeat(200)).length <= 64);
});

test("reads every kind of result", () => {
  assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
  assert.match(resultText({ content: [{ type: "text", text: "bad" }], isError: true }), /reported an error:\nbad/);
  assert.equal(resultText({ content: [{ type: "resource", resource: { uri: "u", text: "body" } }] }), "body");
  assert.equal(resultText({ content: [{ type: "resource_link", uri: "file:///a" }] }), "[Link file:///a]");
  assert.match(resultText({ content: [{ type: "image", data: "x" }] }), /image content isn't shown/);
  assert.equal(resultText({}), "(no output)");
});
