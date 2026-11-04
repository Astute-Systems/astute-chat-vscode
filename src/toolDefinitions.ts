import type { ChatMode } from "./modes";
import { MODES } from "./modes";
import type { ToolDefinition } from "./ollamaClient";

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

export const READ_TOOLS: ToolDefinition[] = [
  tool("list_files", "List workspace files that match a glob pattern.", { pattern: { type: "string", description: "Glob pattern, for example src/**/*.ts" } }, ["pattern"]),
  tool(
    "read_file",
    "Read a text file from the workspace, optionally limited to a line range.",
    {
      path: { type: "string", description: "Path relative to the workspace root" },
      start_line: { type: "integer", description: "First line to read, starting at 1" },
      end_line: { type: "integer", description: "Last line to read" },
    },
    ["path"],
  ),
  tool(
    "probe_command",
    "Run a read-only shell command straight away, with no approval, to check git or the system. Use it for git status, git log, git diff, git branch, uname -a, df -h, free -h, ps, ollama list and similar. Commands that change anything are refused.",
    { command: { type: "string", description: "The read-only command to run" } },
    ["command"],
  ),
  tool("find_code", "Find the code most relevant to a plain description, across the workspace. Use this first when you don't know where something lives. For an exact string, use search_text.", { query: { type: "string", description: "What you're looking for, in words or code names" } }, ["query"]),
  tool("get_problems", "List the errors and warnings from the VS Code Problems panel, optionally for one file.", { path: { type: "string", description: "Optional path relative to the workspace root" } }, []),
  tool("read_terminal", "Read the user's recent VS Code terminal commands and their output. Use this when they mention a terminal, a command they ran, or \"that error\".", {}, []),
  tool(
    "view_image",
    "Look at a PNG or JPEG in the workspace, such as a screenshot. Returns a description and the text in the image.",
    {
      path: { type: "string", description: "Path relative to the workspace root" },
      question: { type: "string", description: "Optional question about the image" },
    },
    ["path"],
  ),
  tool(
    "search_text",
    "Search workspace files for text, ignoring case. Returns matching lines with file and line number.",
    {
      query: { type: "string", description: "Text to find" },
      pattern: { type: "string", description: "Optional glob pattern that limits the files searched" },
    },
    ["query"],
  ),
];

export const CHANGE_TOOLS: ToolDefinition[] = [
  tool(
    "write_file",
    "Create a file, or replace all of an existing file. The user must approve this.",
    {
      path: { type: "string", description: "Path relative to the workspace root" },
      content: { type: "string", description: "The complete file content" },
    },
    ["path", "content"],
  ),
  tool(
    "edit_file",
    "Replace one exact, unique piece of text in a file. The user must approve this.",
    {
      path: { type: "string", description: "Path relative to the workspace root" },
      old_text: { type: "string", description: "Exact text to replace. It must appear exactly once." },
      new_text: { type: "string", description: "Replacement text" },
    },
    ["path", "old_text", "new_text"],
  ),
  tool("run_command", "Run any shell command in the workspace root, such as git add, git commit, make or systemctl. Runs non-interactively. Commands stop after two minutes. The user may need to approve this.", { command: { type: "string", description: "The command to run" } }, ["command"]),
];

/** Shows the user a checklist. It's a separate list because it changes nothing, but only Agent needs it. */
export const TASK_TOOL = tool(
  "update_tasks",
  "Show the user a checklist of the steps in a task with three or more steps. Call it at the start, and again as steps finish. Send the whole list each time.",
  {
    tasks: {
      type: "array",
      items: { type: "object", properties: { title: { type: "string" }, done: { type: "boolean" } }, required: ["title", "done"] },
    },
  },
  ["tasks"],
);

export function toolsForMode(mode: ChatMode): ToolDefinition[] {
  return MODES[mode].canChange ? [...READ_TOOLS, ...CHANGE_TOOLS, TASK_TOOL] : READ_TOOLS;
}

/** Checked again when a tool runs, because a model can call tools it was not offered. */
export function isToolAllowed(mode: ChatMode, name: string): boolean {
  return toolsForMode(mode).some((definition) => definition.function.name === name);
}

/** Replaces the single occurrence of oldText, or explains why it cannot. */
export function replaceUnique(text: string, oldText: string, newText: string): { text: string } | { error: string } {
  if (!oldText) {
    return { error: "old_text is empty." };
  }
  const first = text.indexOf(oldText);
  if (first < 0) {
    return { error: "old_text was not found. Read the file and copy the text exactly." };
  }
  if (text.indexOf(oldText, first + 1) >= 0) {
    return { error: "old_text appears more than once. Include more surrounding text." };
  }
  return { text: `${text.slice(0, first)}${newText}${text.slice(first + oldText.length)}` };
}
