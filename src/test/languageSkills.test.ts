import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { findAgentsFile } from "../agentsFile";
import { detectLanguages, LANGUAGE_SKILLS } from "../languageSkills";

test("reads the language from the request first", () => {
  assert.deepEqual(detectLanguages("Write a C static library", "a.py", []), ["c"]);
  assert.deepEqual(detectLanguages("Write .a library", undefined, []), ["c"]);
  assert.deepEqual(detectLanguages("Write a C++ static library", undefined, []), ["cpp"]);
  assert.deepEqual(detectLanguages("Add a pytest test", "main.c", []), ["python"]);
  assert.deepEqual(detectLanguages("Call the C++ code from Python", undefined, []), ["cpp", "python"]);
});

test("falls back to the open file, then the project", () => {
  assert.deepEqual(detectLanguages("fix this", "src/main.cpp", ["a.py"]), ["cpp"]);
  assert.deepEqual(detectLanguages("fix this", undefined, ["pyproject.toml", "README.md"]), ["python"]);
  assert.deepEqual(detectLanguages("fix this", undefined, ["main.c", "main.h"]), ["c"]);
  assert.deepEqual(detectLanguages("fix this", "notes.md", ["a.cc", "b.py", "c.c"]), ["cpp", "python"]);
});

test("adds nothing when the language is unknown", () => {
  assert.deepEqual(detectLanguages("what is a mutex", undefined, ["README.md"]), []);
  assert.deepEqual(detectLanguages("Explain car parks and traffic", undefined, []), []);
});

test("keeps skills small enough for a local context window", () => {
  for (const skill of Object.values(LANGUAGE_SKILLS)) {
    assert.ok(skill.content.length / 4 < 300, skill.id);
  }
});

test("the closest AGENTS.md wins, and files outside the workspace are ignored", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astute-agents-"));
  fs.mkdirSync(path.join(root, "pkg/src"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "root rules");
  fs.writeFileSync(path.join(root, "pkg/AGENTS.md"), "package rules");
  assert.equal((await findAgentsFile([root]))?.content, "root rules");
  assert.equal((await findAgentsFile([root], path.join(root, "pkg/src/a.c")))?.content, "package rules");
  assert.equal((await findAgentsFile([root], path.join(root, "other.c")))?.content, "root rules");
  assert.equal((await findAgentsFile([path.join(root, "pkg/src")], path.join(root, "pkg/src/a.c")))?.content, undefined);

  const outside = path.join(os.tmpdir(), `astute-outside-${process.pid}.md`);
  fs.writeFileSync(outside, "secret");
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), "astute-link-"));
  fs.symlinkSync(outside, path.join(linked, "AGENTS.md"));
  assert.equal(await findAgentsFile([linked]), undefined);

  fs.writeFileSync(path.join(root, "AGENTS.md"), "x".repeat(5000));
  const long = await findAgentsFile([root]);
  assert.equal(long?.content.length, 4000);
  assert.equal(long?.shortened, true);
});
