import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { isInside, isSensitivePath } from "../pathGuard";
import { findSkills, matchSkill, parseFrontmatter, parseSkill, parseSlash } from "../skillLoader";

const skills = findSkills([{ uri: { fsPath: process.cwd() } }]);

test("loads the workspace skills with their frontmatter", () => {
  assert.deepEqual(skills.map((skill) => skill.name), ["code-review", "workspace-overview"]);
  assert.ok(skills[0].keywords.includes("bugs"));
});

test("matches the natural prompts that used to fail", () => {
  const expected: Record<string, string | undefined> = {
    "review this code": "code-review",
    "can you review my function for bugs": "code-review",
    "code review please": "code-review",
    "code-review this": "code-review",
    "give me an overview of this workspace": "workspace-overview",
    "summarise the project structure": "workspace-overview",
    "fix the code in main": undefined,
    "what is a mutex": undefined,
  };
  for (const [prompt, name] of Object.entries(expected)) {
    assert.equal(matchSkill(prompt, skills)?.name, name, prompt);
  }
});

test("only treats --- at the start of a file as frontmatter", () => {
  const text = "# Title\n\nbefore\n\n---\nmiddle\n---\n\nafter";
  assert.equal(parseFrontmatter(text).body, text);
  const skill = parseSkill("/x/demo/README.md", "---\nname: demo-skill\ndescription: Does demos\nkeywords: [a, b]\n---\n# Demo\nBody\n\n---\n\nKept");
  assert.equal(skill.name, "demo-skill");
  assert.equal(skill.description, "Does demos");
  assert.deepEqual(skill.keywords, ["a", "b"]);
  assert.match(skill.content, /Kept/);
});

test("recognises slash commands and leaves other text alone", () => {
  assert.deepEqual(parseSlash("/help", skills), { kind: "help" });
  assert.deepEqual(parseSlash("/clear", skills), { kind: "clear" });
  const command = parseSlash("/code-review the parser", skills);
  assert.ok(command.kind === "skill" && command.prompt === "the parser");
  assert.deepEqual(parseSlash("/unknown thing", skills), { kind: "unknown", name: "unknown" });
  assert.deepEqual(parseSlash("/code-reveiw", skills), { kind: "unknown", name: "code-reveiw" });
  assert.deepEqual(parseSlash("/etc/hosts has a bad line", skills), { kind: "none" }, "a path isn't a command");
  const alone = parseSlash("/code-review", skills);
  assert.ok(alone.kind === "skill" && alone.prompt === "");
  assert.deepEqual(parseSlash("plain /help", skills), { kind: "none" });
});

test("guards workspace paths and secret files", () => {
  assert.ok(isInside("/repo", path.resolve("/repo", "src/a.ts")));
  assert.ok(!isInside("/repo", path.resolve("/repo", "../etc/passwd")));
  assert.ok(!isInside("/repo", "/repo-other/a.ts"));
  for (const file of [".env", "a/.env.local", ".git/config", "keys/server.pem", "home/.ssh/config", "id_rsa", ".npmrc"]) {
    assert.ok(isSensitivePath(file), file);
  }
  for (const file of ["src/env.ts", "keyboard.ts", "docs/key.md"]) {
    assert.ok(!isSensitivePath(file), file);
  }
});
