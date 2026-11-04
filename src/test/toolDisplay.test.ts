import * as assert from "node:assert/strict";
import { test } from "node:test";
import { describeToolCall } from "../toolDisplay";

const call = (name: string, args: unknown): string => `${name}(${JSON.stringify(args)})`;

test("shows written files as real code, not escaped JSON", () => {
  const shown = describeToolCall(call("write_file", { path: "src/a.c", content: 'int a;\n"b"\n' }));
  assert.deepEqual(shown, { name: "write_file", target: "src/a.c", code: 'int a;\n"b"\n' });
});

test("shows edits as removed and added lines", () => {
  assert.equal(describeToolCall(call("edit_file", { path: "a.c", old_text: "one\ntwo", new_text: "three" })).code, "- one\n- two\n+ three");
});

test("shows commands and simple reads", () => {
  assert.deepEqual(describeToolCall(call("run_command", { command: "make" })), { name: "run_command", target: "", code: "make" });
  assert.equal(describeToolCall(call("probe_command", { command: "git status" })).code, "git status");
  assert.deepEqual(describeToolCall(call("read_file", { path: "a.c", start_line: 1 })), { name: "read_file", target: "a.c" });
  assert.deepEqual(describeToolCall(call("list_files", { pattern: "**/*" })), { name: "list_files", target: "**/*" });
  assert.equal(describeToolCall(call("search_text", { query: "add", pattern: "*.c" })).target, "add in *.c");
});

test("reads a task list, and tolerates a bad one", () => {
  assert.deepEqual(describeToolCall(call("update_tasks", { tasks: [{ title: "Build", done: true }, { title: "Test" }] })).tasks, [{ title: "Build", done: true }, { title: "Test", done: false }]);
  assert.deepEqual(describeToolCall(call("update_tasks", { tasks: "none" })).tasks, []);
});

test("handles missing arguments and unreadable calls", () => {
  assert.deepEqual(describeToolCall("write_file({})"), { name: "write_file", target: "", code: "" });
  assert.equal(describeToolCall("write_file({broken").name, "tool");
  assert.equal(describeToolCall("write_file({broken)").code, "{broken");
});
