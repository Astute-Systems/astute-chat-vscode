import * as assert from "node:assert/strict";
import { test } from "node:test";
import { checkEditContent, checkFileContent } from "../contentGuard";

const refused = (file: string, content: string): boolean => checkFileContent(file, content) !== undefined;

test("refuses the empty library that was actually written", () => {
  assert.ok(refused("libmylib.a", ""));
  assert.ok(refused("libmylib.a", "real looking text"));
  for (const file of ["add.o", "lib/x.so", "a.dll", "app.exe", "firmware.bin", "shot.png", "doc.pdf"]) {
    assert.ok(refused(file, "content"), file);
  }
});

test("refuses empty files, except ones meant to be empty", () => {
  for (const file of ["add.c", "notes.md", "config.json"]) {
    assert.ok(refused(file, "  \n"), file);
  }
  for (const file of ["pkg/__init__.py", ".gitkeep", "src/py.typed"]) {
    assert.ok(!refused(file, ""), file);
  }
});

test("refuses placeholder code the models really produced", () => {
  assert.ok(refused("src/library.js", "// Library file\nexport function myLibraryFunction() {\n  // Function implementation\n}"));
  assert.ok(refused("a.c", "int add(int a, int b) {\n  // TODO: implement\n  return 0;\n}"));
  assert.ok(refused("a.py", "def add(a, b):\n    # your code here\n    pass"));
  assert.ok(refused("a.c", "// just a comment\n/* and another */"));
});

test("refuses the sample file that got past the first version of this check", () => {
  assert.ok(refused("lib", "// This is a sample library\nexport function hello() {\n    console.log('Hello, world!');\n}"));
  assert.ok(refused("src/thing", "# example code\nprint('x')"));
});

test("allows real code, including words that only look like placeholders", () => {
  assert.equal(checkFileContent("add.c", "int add(int a, int b) {\n  return a + b;\n}\n"), undefined);
  assert.equal(checkFileContent("a.c", "#include <stdio.h>\nint main(void) { return 0; }\n"), undefined);
  assert.equal(checkFileContent("ui.ts", 'input.placeholder = "Type here";\nconst dummy = 1;\n'), undefined);
  assert.equal(checkFileContent("README.md", "// This is a sample library."), undefined);
  assert.equal(checkFileContent("config.yaml", "# example code\nkey: value\n"), undefined);
  assert.equal(checkFileContent("hello.c", "// Prints a greeting\n#include <stdio.h>\nint main(void) { puts(\"hi\"); }\n"), undefined);
  assert.equal(checkFileContent("Makefile", "all:\n\tgcc -c add.c\n"), undefined);
  assert.equal(checkFileContent("a.py", "#!/usr/bin/env python3\nprint('hi')\n"), undefined);
});

test("checks the new text of an edit, and allows deletions", () => {
  assert.equal(checkEditContent("a.c", ""), undefined);
  assert.equal(checkEditContent("a.c", "return a + b;"), undefined);
  assert.notEqual(checkEditContent("a.c", "// placeholder"), undefined);
  assert.notEqual(checkEditContent("lib.a", "x"), undefined);
});
