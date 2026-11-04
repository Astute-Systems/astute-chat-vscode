import type { ApprovalLevel } from "./modes";
import { isSensitivePath } from "./pathGuard";

export interface ChangeRequest {
  kind: "edit" | "command" | "tool";
  title: string;
  detail: string;
  path?: string;
  command?: string;
  /** Sizes in characters when an edit replaces a whole existing file. */
  existingSize?: number;
  newSize?: number;
  /** The file's full path and its text after the change, for the diff view. */
  file?: string;
  proposed?: string;
}

export type SafetyResult = { safe: true } | { safe: false; reason: string };

const RISKY_PATHS: Array<[RegExp, string]> = [
  [/^\.vscode\//, "VS Code tasks and settings can run commands"],
  [/^\.github\//, "workflows run automatically"],
  [/^\.gitlab-ci\.yml$/, "pipelines run automatically"],
  [/^\.husky\//, "Git hooks run automatically"],
  [/^\.devcontainer\//, "dev containers run setup commands"],
  [/^\.astute\//, "skills become instructions for the model"],
  [/(^|\/)(package\.json|Makefile|makefile|CMakeLists\.txt|Dockerfile|docker-compose\.ya?ml|setup\.py|pyproject\.toml|build\.gradle|pom\.xml)$/, "build files can run commands"],
  [/\.(sh|bash|ps1|bat|cmd)$/, "scripts can run commands"],
];

/** Read-only commands. Build and test commands run project code, so they are not here. */
const READ_ONLY_COMMANDS = new Set(
  "ls pwd cat head tail wc grep rg find echo which whoami date file stat du df tree diff basename dirname uname hostname hostnamectl id groups uptime free nproc lscpu lsblk lsmod lspci lsusb lsb_release ps nvidia-smi".split(" "),
);
const READ_ONLY_GIT = new Set("status diff log show blame rev-parse describe ls-files shortlog rev-list ls-tree".split(" "));
/** Commands that are only read-only in the exact forms listed here. */
const READ_ONLY_FORMS = [
  /^git branch( (-a|-r|-v|-vv|--all|--list|--show-current))*$/,
  /^git remote( -v)?$/,
  /^git tag( -l| --list)?$/,
  /^git stash list$/,
  /^git reflog( -n ?\d+)?$/,
  /^git config --get [\w.-]+$/,
  /^git config (--list|-l)$/,
  /^(gcc|g\+\+|clang|clang\+\+|make|cmake|python3?|pip3?|node|npm|cargo|rustc|go|java|ollama|docker|ld|ar|gdb) (--version|-v|version)$/,
  /^systemctl (status|is-active|is-enabled) [\w@.-]+( --no-pager)?$/,
  /^ollama (list|ps)$/,
  /^ip (addr|a|route|r|link)( show)?$/,
];
const UNSAFE_SHELL = /[$`<>\\\n\r]|(^|[^&])&($|[^&])/;
const UNSAFE_ARGUMENTS: Record<string, RegExp> = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  rg: /^--(pre|pre-glob|replace)/,
  git: /^--(output|ext-diff|textconv|exec)/,
  grep: /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)$/,
  tree: /^-o$/,
  diff: /^--output/,
};

export function checkEdit(change: Pick<ChangeRequest, "path" | "existingSize" | "newSize">): SafetyResult {
  const file = (change.path ?? "").replace(/\\/g, "/");
  for (const [pattern, why] of RISKY_PATHS) {
    if (pattern.test(file)) {
      return { safe: false, reason: `${file} is a sensitive file: ${why}.` };
    }
  }
  if (change.existingSize !== undefined && change.newSize !== undefined && change.existingSize > 200 && change.newSize < change.existingSize / 2) {
    return { safe: false, reason: "This removes more than half of the file." };
  }
  return { safe: true };
}

/**
 * Approves only commands proven read-only: anything unrecognised is risky, so a
 * new or clever command pauses for review. Quoted text is not parsed, which can
 * only make a command look riskier than it is.
 */
export function checkCommand(command: string, allowed: readonly string[] = []): SafetyResult {
  const text = command.trim();
  if (!text) {
    return { safe: false, reason: "The command is empty." };
  }
  if (UNSAFE_SHELL.test(text)) {
    return { safe: false, reason: "It uses shell features such as redirects or substitution." };
  }

  for (const segment of text.split(/&&|\|\||;|\|/).map((part) => part.trim())) {
    if (!segment) {
      continue;
    }
    if (allowed.some((prefix) => segment === prefix.trim() || segment.startsWith(`${prefix.trim()} `))) {
      continue;
    }

    if (READ_ONLY_FORMS.some((form) => form.test(segment))) {
      continue;
    }

    const words = segment.split(/\s+/);
    const program = words[0];
    const args = words.slice(1);
    const known = READ_ONLY_COMMANDS.has(program) || (program === "git" && READ_ONLY_GIT.has(args[0] ?? ""));
    if (!known) {
      return { safe: false, reason: `${program} isn't on the read-only list.` };
    }

    for (const raw of args) {
      const arg = raw.replace(/^["']|["']$/g, "");
      if (UNSAFE_ARGUMENTS[program]?.test(arg)) {
        return { safe: false, reason: `${program} ${arg} can change files or read too widely.` };
      }
      if (arg.startsWith("/") || arg.startsWith("~") || arg.split("/").includes("..")) {
        return { safe: false, reason: "It reaches outside the workspace." };
      }
      // git show HEAD:.env names a file after the colon.
      if (isSensitivePath(arg) || arg.split(":").some(isSensitivePath)) {
        return { safe: false, reason: "It reads a file that may contain secrets." };
      }
    }
  }
  return { safe: true };
}

/** Decides whether a change can go ahead or must wait for the user. */
export function decide(level: ApprovalLevel, change: ChangeRequest, allowedCommands: readonly string[] = []): { allow: boolean; reason?: string } {
  // Hard limits such as workspace paths and the dummy file check still apply,
  // because they run before approval in tools.ts.
  if (level === "full") {
    return { allow: true };
  }
  // MCP tools can do anything, and the spec says their own labels can't be trusted.
  if (level === "ask" || change.kind === "tool") {
    return { allow: false };
  }
  if (change.kind === "edit") {
    const result = checkEdit(change);
    return result.safe ? { allow: true } : { allow: false, reason: result.reason };
  }
  if (level === "edits") {
    return { allow: false };
  }
  const result = checkCommand(change.command ?? "", allowedCommands);
  return result.safe ? { allow: true } : { allow: false, reason: result.reason };
}
