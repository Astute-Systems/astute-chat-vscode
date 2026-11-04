import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildRequestContext, listFolder } from "../contextFiles";

const open = { file: "src/a.c", language: "c", text: "int add(void);" };

test("adds the open file, and says it is what the user means", async () => {
  const context = await buildRequestContext(open, []);
  assert.match(context, /"this file"/);
  assert.match(context, /src\/a\.c/);
  assert.match(context, /int add\(void\);/);
});

test("adds nothing without a file, and never adds a secret file", async () => {
  assert.equal(await buildRequestContext(undefined, []), "");
  assert.equal(await buildRequestContext({ file: ".env", language: "", text: "KEY=1" }, []), "");
});

test("shortens large files and large totals", async () => {
  const big = await buildRequestContext({ ...open, text: "x".repeat(20000) }, []);
  assert.ok(big.length < 7000);
  assert.match(big, /Use read_file/);
});

test("describes a selected folder without secrets or build folders", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astute-context-"));
  fs.mkdirSync(path.join(root, "drivers/i2c"), { recursive: true });
  fs.mkdirSync(path.join(root, "drivers/node_modules/x"), { recursive: true });
  fs.writeFileSync(path.join(root, "drivers/i2c/bus.c"), "int bus;");
  fs.writeFileSync(path.join(root, "drivers/.env"), "KEY=1");
  const context = await buildRequestContext(undefined, [{ file: path.join(root, "drivers"), shown: "drivers" }]);
  assert.match(context, /selected the folder drivers\//);
  assert.match(context, /put any new files there/);
  assert.match(context, /bus\.c/);
  assert.doesNotMatch(context, /\.env|node_modules/);
  assert.deepEqual(await listFolder(path.join(root, "drivers")), ["i2c/", "  bus.c"]);
});

test("adds a selected file once, even when it is also open", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astute-context-"));
  fs.writeFileSync(path.join(root, "a.c"), "int real;");
  const context = await buildRequestContext({ file: "a.c", language: "c", text: "int real;" }, [{ file: path.join(root, "a.c"), shown: "a.c" }]);
  assert.equal(context.match(/int real;/g)?.length, 1);
});
