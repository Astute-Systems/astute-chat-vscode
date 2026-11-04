import * as assert from "node:assert/strict";
import { test } from "node:test";
import { canRunInTerminal, snippetLanguage, toTerminalCommand } from "../snippets";

test("reads the language from a code element", () => {
  assert.equal(snippetLanguage("language-bash"), "bash");
  assert.equal(snippetLanguage("hljs language-C++"), "c++");
  assert.equal(snippetLanguage(""), "");
});

test("offers Run only for shell snippets", () => {
  for (const language of ["", "bash", "sh", "shell", "console", "powershell"]) {
    assert.ok(canRunInTerminal(language), language);
  }
  for (const language of ["c", "python", "typescript", "json", "yaml"]) {
    assert.ok(!canRunInTerminal(language), language);
  }
});

test("removes prompts only when every command has one", () => {
  assert.equal(toTerminalCommand("$ make\n$ make test\n"), "make\nmake test");
  assert.equal(toTerminalCommand("ls -la\n"), "ls -la");
  assert.equal(toTerminalCommand("echo cost\n$ not a prompt"), "echo cost\n$ not a prompt");
  assert.equal(toTerminalCommand("echo $HOME"), "echo $HOME");
});
