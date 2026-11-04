export type LanguageId = "c" | "cpp" | "python";

export interface LanguageSkill {
  id: LanguageId;
  title: string;
  content: string;
}

/**
 * Keep these short, because they use up the context window on every turn. Each
 * rule should fix a mistake seen in a real run. These are off by default: in 24
 * real runs they did not improve results, and a virtual environment rule made
 * Python worse. See src/integration/eval.ts before turning them on by default.
 */
export const LANGUAGE_SKILLS: Record<LanguageId, LanguageSkill> = {
  c: {
    id: "c",
    title: "C",
    content: `- If the project has a Makefile or CMakeLists.txt, use it and don't compile by hand.
- Put code in .c files and declarations in .h files with include guards.
- Build a static library in two steps: \`gcc -Wall -Wextra -c add.c -o add.o\`, then \`ar rcs libadd.a add.o\`. Never use \`gcc -o libadd.a\`, because that links a program.
- Run commands from the workspace root. Paths such as src/add.c stay relative to it.
- After building, prove it works: write a small test program, link it with \`gcc test.c -L. -ladd -o test\`, and run it.
- If a command fails, fix the first error and run it again. Don't report success until it passes.`,
  },
  cpp: {
    id: "cpp",
    title: "C++",
    content: `- If the project has a CMakeLists.txt or Makefile, use it. For CMake, run \`cmake -S . -B build\` then \`cmake --build build\`.
- Put code in .cpp files and declarations in .hpp files with \`#pragma once\`. Templates stay in the header.
- Build a static library in two steps: \`g++ -std=c++17 -Wall -Wextra -c stack.cpp -o stack.o\`, then \`ar rcs libstack.a stack.o\`. Never use \`g++ -o libstack.a\`, because that links a program.
- A library needs at least one .cpp file with compiled code. A header-only library produces an empty archive.
- Don't put \`using namespace std;\` in headers. Prefer RAII and standard containers to raw new and delete.
- After building, prove it works: write a small test program, link it with \`g++ test.cpp -L. -lstack -o test\`, and run it.
- If a command fails, fix the first error and run it again. Don't report success until it passes.`,
  },
  python: {
    id: "python",
    title: "Python",
    content: `- Use \`python3\`, not \`python\`.
- If the project already has a virtual environment, use it. Otherwise use what is installed, and create one with \`python3 -m venv .venv\` only if a package is missing and pip refuses to install it.
- A package named calc is a folder calc/ containing __init__.py and its modules. Put tests in tests/, in files named test_*.py.
- Run tests from the workspace root with \`python3 -m pytest\`.
- Write real function bodies with type hints. Don't leave \`pass\` or \`...\` as an implementation.
- After writing code, run it or its tests to prove it works.
- If a command fails, fix the first error and run it again. Don't report success until it passes.`,
  },
};

const MAX_SKILLS = 2;
const PROJECT_FILES: Array<[RegExp, LanguageId]> = [
  [/\.(cpp|cc|cxx|hpp|hh|ipp)$/i, "cpp"],
  [/^(pyproject\.toml|setup\.py|requirements\.txt|Pipfile)$|\.py$/i, "python"],
  [/\.(c|h)$/i, "c"],
];

function fromPrompt(prompt: string): LanguageId[] {
  const found: LanguageId[] = [];
  const cpp = /c\+\+|\bcpp\b|\bg\+\+|\.(cpp|hpp|cc)\b/i.test(prompt);
  if (cpp) {
    found.push("cpp");
  } else if (/\bC\b|\bc (static |shared )?(library|lib|program|code|file|project)\b|\bgcc\b|\.[ch]\b|\.a\b|static library/.test(prompt)) {
    found.push("c");
  }
  if (/\bpython\b|\bpytest\b|\bpip\b|\.py\b/i.test(prompt)) {
    found.push("python");
  }
  return found;
}

function fromFile(file: string): LanguageId | undefined {
  return PROJECT_FILES.find(([pattern]) => pattern.test(file))?.[1];
}

/** Picks skills from the request first, then the open file, then the project's files. */
export function detectLanguages(prompt: string, activeFile: string | undefined, projectFiles: readonly string[]): LanguageId[] {
  const named = fromPrompt(prompt);
  if (named.length) {
    return named.slice(0, MAX_SKILLS);
  }
  const active = activeFile ? fromFile(activeFile) : undefined;
  if (active) {
    return [active];
  }
  const found = new Set<LanguageId>();
  for (const [pattern, language] of PROJECT_FILES) {
    if (projectFiles.some((file) => pattern.test(file))) {
      found.add(language);
    }
  }
  return [...found].slice(0, MAX_SKILLS);
}
