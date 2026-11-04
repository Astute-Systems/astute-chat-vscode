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
  "ls pwd cat head tail wc grep rg sed find echo which whoami file stat du df tree diff basename dirname uname id groups uptime free nproc lscpu lsblk lsmod lspci lsusb lsb_release ps".split(" "),
);
const READ_ONLY_GIT = new Set("status diff log show blame rev-parse describe ls-files shortlog rev-list ls-tree grep".split(" "));
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
  // These can also change the system, so only forms that just report are listed.
  /^date( -u| -R| --utc| --iso-8601(=\w+)?| \+[\w%:./-]+)*$/,
  /^hostname( -[fsiI])?$/,
  /^hostnamectl( status)?$/,
  /^nvidia-smi( -L| --list-gpus| --query-[\w-]+=[\w.,]+| --format=[\w,-]+)*$/,
];
const UNSAFE_SHELL = /[$`<>\\\n\r]|(^|[^&])&($|[^&])/;
const UNSAFE_ARGUMENTS: Record<string, RegExp> = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  // Hidden and ignored files are where secrets live, and -g patterns can name them.
  rg: /^(--(pre|pre-glob|replace|hostname-bin|hidden|no-ignore|unrestricted|glob|iglob|files-from)|-[a-zA-Z.]*[ug.])/,
  // git grep reads tracked files only, unless these widen it to .env or start a program.
  git: /^(--(output|ext-diff|textconv|exec|no-index|untracked|no-exclude-standard|open-files-in-pager)|-O)/,
  grep: /^(-[a-zA-Z]*[rRd][a-zA-Z]*|--recursive|--dereference-recursive|--directories)/,
  tree: /^-[a-zA-Z]*o/,
  diff: /^--output/,
  file: /^(-[a-zA-Z]*C|--compile)/,
};

interface ShellWord {
  /** The word as the program receives it, with quotes removed. */
  value: string;
  /** The shell would expand this into file names. */
  pattern: boolean;
}

interface ShellSegment {
  text: string;
  words: ShellWord[];
}

/**
 * Splits a command the way the shell does, because checking the text as written
 * lets '.en'v and .en* reach .env. Returns nothing if a quote isn't closed.
 * UNSAFE_SHELL has already refused substitution, backslashes and newlines.
 */
function parseShell(text: string): ShellSegment[] | undefined {
  const segments: ShellSegment[] = [];
  let words: ShellWord[] = [];
  let word: ShellWord | undefined;
  let quote = "";
  let start = 0;
  const endWord = (): void => {
    if (word) {
      words.push(word);
      word = undefined;
    }
  };
  const endSegment = (end: number): void => {
    endWord();
    segments.push({ text: text.slice(start, end).trim(), words });
    words = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        (word as ShellWord).value += char;
      }
    } else if (/\s/.test(char)) {
      endWord();
    } else if (char === ";" || char === "|" || char === "&") {
      endSegment(index);
      if (text[index + 1] === char) {
        index++;
      }
      start = index + 1;
    } else {
      word ??= { value: "", pattern: false };
      if (char === "'" || char === '"') {
        quote = char;
      } else {
        word.pattern ||= /[*?[{]/.test(char);
        word.value += char;
      }
    }
  }
  if (quote) {
    return undefined;
  }
  endSegment(text.length);
  return segments;
}

/** sed can write files and run commands, so only printing a line range counts as reading. */
function isLineRangeSed(args: ShellWord[]): boolean {
  return args[0]?.value === "-n" && /^\d+(,\d+)?p$/.test(args[1]?.value ?? "") && !args.slice(2).some((arg) => arg.value.startsWith("-"));
}

/** An argument can carry a path after an option, as in --file=.env, -f.env or HEAD:.env. */
function pathsIn(arg: string): string[] {
  return [arg, ...arg.split(/[=:]/), ...(/^-[^-]/.test(arg) ? [arg.slice(2)] : [])];
}

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
 * new or clever command pauses for review. Arguments are checked as the shell
 * would pass them, because that's what the program reads.
 */
export function checkCommand(command: string, allowed: readonly string[] = []): SafetyResult {
  const text = command.trim();
  if (!text) {
    return { safe: false, reason: "The command is empty." };
  }
  if (UNSAFE_SHELL.test(text)) {
    return { safe: false, reason: "It uses shell features such as redirects or substitution." };
  }

  const segments = parseShell(text);
  if (!segments) {
    return { safe: false, reason: "A quote isn't closed." };
  }
  for (const { text: segment, words } of segments) {
    if (!segment) {
      continue;
    }
    if (allowed.some((prefix) => segment === prefix.trim() || segment.startsWith(`${prefix.trim()} `))) {
      continue;
    }

    if (READ_ONLY_FORMS.some((form) => form.test(segment))) {
      continue;
    }

    const program = words[0].value;
    const args = words.slice(1);
    const known = READ_ONLY_COMMANDS.has(program) || (program === "git" && READ_ONLY_GIT.has(args[0]?.value ?? ""));
    if (!known) {
      return { safe: false, reason: `${program} isn't on the read-only list.` };
    }

    if (program === "sed" && !isLineRangeSed(args)) {
      return { safe: false, reason: "Only sed -n with a line range, such as sed -n 10,20p, is read-only." };
    }

    for (const { value: arg, pattern } of args) {
      if (pattern) {
        return { safe: false, reason: "It uses a shell pattern, which could match a file that holds secrets." };
      }
      if (UNSAFE_ARGUMENTS[program]?.test(arg)) {
        return { safe: false, reason: `${program} ${arg} can change files or read too widely.` };
      }
      // Git expands patterns itself, so quoting one doesn't make it literal.
      if (program === "git" && !arg.startsWith("-") && /[*?[]/.test(arg)) {
        return { safe: false, reason: "It uses a Git pattern, which could match a file that holds secrets." };
      }
      for (const part of pathsIn(arg)) {
        if (part.startsWith("/") || part.startsWith("~") || part.split("/").includes("..")) {
          return { safe: false, reason: "It reaches outside the workspace." };
        }
        if (isSensitivePath(part)) {
          return { safe: false, reason: "It reads a file that may contain secrets." };
        }
      }
    }
  }
  return { safe: true };
}

/** Commands get no input, so an interactive chat starts and ends at once, which looks like it did nothing. */
export function interactiveCommandHint(command: string): string | undefined {
  const model = /^\s*ollama\s+run\s+([^\s-]\S*)\s*$/.exec(command)?.[1];
  return model
    ? `This model is available, but "ollama run ${model}" with no prompt opens an interactive chat, and commands here get no input, so it closed straight away. To try it, use: ollama run ${model} "your prompt". To chat with it, tell the user to choose it in the model list.`
    : undefined;
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
