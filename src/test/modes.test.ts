import * as assert from "node:assert/strict";
import { test } from "node:test";
import { isChatMode, MODES } from "../modes";
import { findSkills, parseSlash } from "../skillLoader";
import { CHANGE_TOOLS, isToolAllowed, matchesIn, READ_TOOLS, replaceUnique, toolsForMode } from "../toolDefinitions";

const names = (mode: "ask" | "plan" | "agent"): string[] => toolsForMode(mode).map((tool) => tool.function.name);
const changing = CHANGE_TOOLS.map((tool) => tool.function.name);

test("Ask and Plan are never offered tools that change anything", () => {
  for (const mode of ["ask", "plan"] as const) {
    assert.deepEqual(names(mode), READ_TOOLS.map((tool) => tool.function.name));
    assert.equal(MODES[mode].canChange, false);
    for (const tool of changing) {
      assert.equal(isToolAllowed(mode, tool), false, `${mode} ${tool}`);
    }
  }
});

test("Agent can read and change", () => {
  for (const tool of [...names("ask"), ...changing]) {
    assert.ok(isToolAllowed("agent", tool), tool);
  }
  assert.ok(!isToolAllowed("agent", "delete_everything"));
});

test("recognises modes", () => {
  assert.ok(isChatMode("plan"));
  assert.ok(!isChatMode("admin"));
  assert.ok(!isChatMode(undefined));
});

test("switches mode from a slash command", () => {
  const skills = findSkills([{ uri: { fsPath: process.cwd() } }]);
  assert.deepEqual(parseSlash("/plan add a cache", skills), { kind: "mode", mode: "plan", prompt: "add a cache" });
  assert.deepEqual(parseSlash("/agent", skills), { kind: "mode", mode: "agent", prompt: "" });
});

test("edit_file replaces only a unique match", () => {
  assert.deepEqual(replaceUnique("a b c", "b", "x"), { text: "a x c" });
  assert.ok("error" in replaceUnique("a b b", "b", "x"));
  assert.ok("error" in replaceUnique("a", "z", "x"));
  assert.ok("error" in replaceUnique("a", "", "x"));
  assert.deepEqual(replaceUnique("price", "price", "$&"), { text: "$&" });
});

test("search shows the code around each match", () => {
  const text = ["one", "two", "  find me", "four", "five", "six", "seven", "find me too", "nine"].join("\n");
  assert.deepEqual(matchesIn("a.ts", text, "find", 0, 50), ["a.ts:3: find me", "a.ts:8: find me too"]);
  assert.deepEqual(matchesIn("a.ts", text, "find", 1, 50), ["a.ts-2- two", "a.ts:3:   find me", "a.ts-4- four", "--", "a.ts-7- seven", "a.ts:8: find me too", "a.ts-9- nine"]);
  assert.deepEqual(matchesIn("a.ts", text, "find", 2, 1), ["a.ts-1- one", "a.ts-2- two", "a.ts:3:   find me", "a.ts-4- four", "a.ts-5- five"], "the limit counts matches");
  const near = ["a", "x", "b", "x", "c"].join("\n");
  assert.equal(matchesIn("f", near, "x", 1, 50).length, 5, "overlapping context isn't repeated");
});
