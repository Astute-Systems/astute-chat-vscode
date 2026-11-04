import * as fs from "fs";
import * as path from "path";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SUMMARY_CHARS = 1200;
const MAX_FOLDERS = 12;
const BUNDLER_CONFIGS = ["esbuild.js", "esbuild.mjs", "esbuild.config.js", "esbuild.config.mjs", "vite.config.ts", "vite.config.js", "webpack.config.js", "rollup.config.js"];
const USEFUL_SCRIPTS = ["build", "compile", "test", "start", "dev", "lint", "package"];
const CONVENTIONAL_ENTRIES = ["main.py", "app.py", "manage.py", "main.go", "main.c", "main.cpp", "src/main.c", "src/main.cpp", "src/main.py", "src/main.ts", "src/main.js", "src/index.ts", "src/index.js", "index.ts", "index.js"];
const SKIPPED_FOLDERS = new Set(["node_modules", "out", "out-test", "dist", "build", "target", "vendor", "venv", "coverage", "__pycache__"]);

/**
 * Manifests come from the repository, so a value goes into the prompt only if it
 * looks like a name or a path. Free text could carry instructions for the model.
 */
function plain(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w@./:+-]{1,120}$/.test(value) && !value.startsWith("-") ? value : undefined;
}

function read(root: string, file: string): string | undefined {
  try {
    const full = path.join(root, file);
    return fs.statSync(full).size <= MAX_MANIFEST_BYTES ? fs.readFileSync(full, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

const exists = (root: string, file: string): boolean => fs.existsSync(path.join(root, file));
const unique = (items: Array<string | undefined>): string[] => [...new Set(items.filter((item): item is string => Boolean(item)))];

/** A bundler's entry points are the real source files, unlike the built file that package.json names. */
function bundlerEntries(root: string): string[] {
  const found: string[] = [];
  for (const config of BUNDLER_CONFIGS) {
    const text = read(root, config) ?? "";
    for (const list of text.matchAll(/\b(?:entryPoints|entry|input)\s*:\s*(\[[^\]]*\]|["'][^"']+["'])/g)) {
      for (const item of list[1].matchAll(/["']([^"']+)["']/g)) {
        found.push(item[1]);
      }
    }
  }
  return found.map((file) => file.replace(/^\.\//, "")).filter((file) => plain(file) && exists(root, file));
}

/** Maps a built file such as out/extension.js back to src/extension.ts. */
function sourceOf(root: string, built: string): string | undefined {
  const file = built.replace(/^\.\//, "");
  if (exists(root, file) && !/^(out|dist|build|lib)\//.test(file)) {
    return file;
  }
  const stem = file.replace(/^(out|dist|build|lib)\//, "src/").replace(/\.[cm]?js$/, "");
  return [`${stem}.ts`, `${stem}.tsx`, `${stem}.js`].find((candidate) => exists(root, candidate));
}

function nodeProject(root: string): { kind: string; entries: string[]; commands: string[] } | undefined {
  const text = read(root, "package.json");
  if (!text) {
    return undefined;
  }
  let manifest: { name?: unknown; main?: unknown; module?: unknown; bin?: unknown; scripts?: unknown; engines?: { vscode?: unknown } };
  try {
    manifest = JSON.parse(text) as typeof manifest;
  } catch {
    return undefined;
  }
  const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values((manifest.bin as Record<string, unknown>) ?? {});
  const declared = [manifest.main, manifest.module, ...bins].map(plain).filter((file): file is string => Boolean(file));
  const scripts = Object.keys((manifest.scripts as Record<string, unknown>) ?? {});
  return {
    kind: manifest.engines?.vscode ? "VS Code extension" : "Node.js project",
    entries: unique([...bundlerEntries(root), ...declared.map((file) => sourceOf(root, file) ?? file)]),
    commands: USEFUL_SCRIPTS.filter((script) => scripts.includes(script)).map((script) => (script === "test" || script === "start" ? `npm ${script}` : `npm run ${script}`)),
  };
}

function pythonProject(root: string): { kind: string; entries: string[]; commands: string[] } | undefined {
  const text = read(root, "pyproject.toml");
  if (!text) {
    return undefined;
  }
  const scripts = /^\[(?:project\.scripts|tool\.poetry\.scripts)\]\s*\n((?:[^\[\n].*\n?)*)/m.exec(text)?.[1] ?? "";
  const targets = [...scripts.matchAll(/=\s*["']([^"']+)["']/g)].map((match) => plain(match[1]));
  return { kind: "Python project", entries: unique(targets), commands: [] };
}

function rustProject(root: string): { kind: string; entries: string[]; commands: string[] } | undefined {
  const text = read(root, "Cargo.toml");
  if (!text) {
    return undefined;
  }
  const bins = [...text.matchAll(/^path\s*=\s*"([^"]+)"/gm)].map((match) => plain(match[1]));
  return { kind: "Rust project", entries: unique([...bins, ...["src/main.rs", "src/lib.rs"].filter((file) => exists(root, file))]), commands: ["cargo build", "cargo test"] };
}

function goProject(root: string): { kind: string; entries: string[]; commands: string[] } | undefined {
  if (!exists(root, "go.mod")) {
    return undefined;
  }
  let commands: string[] = [];
  try {
    commands = fs.readdirSync(path.join(root, "cmd")).map((name) => `cmd/${name}/main.go`).filter((file) => exists(root, file));
  } catch {
    // Many Go projects have no cmd folder.
  }
  return { kind: "Go project", entries: unique([...(exists(root, "main.go") ? ["main.go"] : []), ...commands]), commands: ["go build ./...", "go test ./..."] };
}

function cmakeProject(root: string): { kind: string; entries: string[]; commands: string[] } | undefined {
  const text = read(root, "CMakeLists.txt");
  if (!text) {
    return undefined;
  }
  const sources = [...text.matchAll(/add_executable\(\s*[^\s)]+([^)]*)\)/g)].flatMap((match) => match[1].trim().split(/\s+/)).filter((file) => plain(file) && exists(root, file));
  return { kind: "CMake project", entries: unique(sources), commands: ["cmake -B build", "cmake --build build"] };
}

function topFolders(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_FOLDERS.has(entry.name) && plain(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_FOLDERS);
  } catch {
    return [];
  }
}

/** A short map of a project, built by code, so finding the entry point doesn't depend on the model looking. */
export function summariseProject(root: string): string {
  const projects = [nodeProject, pythonProject, rustProject, goProject, cmakeProject].map((read) => read(root)).filter((project) => project !== undefined);
  const entries = unique(projects.flatMap((project) => project.entries));
  const conventional = entries.length ? [] : CONVENTIONAL_ENTRIES.filter((file) => exists(root, file));
  const commands = unique(projects.flatMap((project) => project.commands));
  const folders = topFolders(root);
  const lines = [
    projects.length ? `Type: ${unique(projects.map((project) => project.kind)).join(", ")}.` : "",
    [...entries, ...conventional].length ? `Entry points: ${[...entries, ...conventional].join(", ")}.` : "",
    commands.length ? `Commands: ${commands.join(", ")}.` : "",
    folders.length ? `Top folders: ${folders.join(", ")}.` : "",
  ].filter(Boolean);
  if (!lines.length) {
    return "";
  }
  return `Project summary, worked out from its files. Read these entry points first when you need to understand the code.\n${lines.join("\n")}`.slice(0, MAX_SUMMARY_CHARS);
}
