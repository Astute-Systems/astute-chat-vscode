import * as assert from "node:assert/strict";
import { test } from "node:test";
import { isInsecureRemote, isLoopback, parseServerAddress, toBaseUrl, toLabel } from "../server";

test("parses the address forms people type", () => {
  assert.deepEqual(parseServerAddress("192.168.1.20"), { host: "192.168.1.20", port: 11434, https: false });
  assert.deepEqual(parseServerAddress("192.168.1.20:8080"), { host: "192.168.1.20", port: 8080, https: false });
  assert.deepEqual(parseServerAddress("gpu-box"), { host: "gpu-box", port: 11434, https: false });
  assert.deepEqual(parseServerAddress("https://ollama.example.com:8443/"), { host: "ollama.example.com", port: 8443, https: true });
  assert.deepEqual(parseServerAddress("::1"), { host: "::1", port: 11434, https: false });
  assert.deepEqual(parseServerAddress("[fd00::5]:9000"), { host: "fd00::5", port: 9000, https: false });
});

test("rejects invalid addresses with a message", () => {
  for (const value of ["", "   ", "host:99999", "ftp://host", "http://host/api", "http://user:pw@host", "bad host"]) {
    assert.equal(typeof parseServerAddress(value), "string", value);
  }
});

test("builds URLs and labels, bracketing IPv6", () => {
  const address = { host: "fd00::5", port: 9000, https: false };
  assert.equal(toBaseUrl(address), "http://[fd00::5]:9000");
  assert.equal(toLabel(address), "[fd00::5]:9000");
});

test("identifies servers that receive prompts unencrypted", () => {
  assert.ok(isLoopback("127.0.0.1") && isLoopback("localhost") && isLoopback("::1"));
  assert.ok(isInsecureRemote({ host: "10.0.0.2", port: 1, https: false }));
  assert.ok(!isInsecureRemote({ host: "10.0.0.2", port: 1, https: true }));
  assert.ok(!isInsecureRemote({ host: "127.0.0.1", port: 1, https: false }));
});
