export interface ToolDisplay {
  name: string;
  /** The file, pattern or search the tool worked on. */
  target: string;
  /** Code or a command to show in a scrolling window. */
  code?: string;
  /** A checklist, which replaces the previous one instead of adding another. */
  tasks?: Array<{ title: string; done: boolean }>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function linesWith(prefix: string, value: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

/** Turns a tool call such as write_file({"path":"a.c",...}) into something readable. */
export function describeToolCall(call: string): ToolDisplay {
  const match = call.match(/^(\w+)\(([\s\S]*)\)$/);
  if (!match) {
    return { name: "tool", target: "", code: call };
  }
  const name = match[1];
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(match[2]) as Record<string, unknown>;
  } catch {
    return { name, target: "", code: match[2] };
  }

  switch (name) {
    case "write_file":
      return { name, target: text(args.path), code: text(args.content) };
    case "edit_file":
      return { name, target: text(args.path), code: `${linesWith("- ", text(args.old_text))}\n${linesWith("+ ", text(args.new_text))}` };
    case "run_command":
    case "probe_command":
      return { name, target: "", code: text(args.command) };
    case "read_terminal":
      return { name, target: "" };
    case "update_tasks":
      return {
        name,
        target: "",
        tasks: (Array.isArray(args.tasks) ? args.tasks : []).map((task: { title?: unknown; done?: unknown }) => ({ title: text(task?.title), done: task?.done === true })),
      };
    case "find_code":
      return { name, target: text(args.query) };
    case "read_file":
    case "view_image":
    case "get_problems":
      return { name, target: text(args.path) };
    case "list_files":
      return { name, target: text(args.pattern) };
    case "search_text":
      return { name, target: [text(args.query), text(args.pattern)].filter(Boolean).join(" in ") };
    default:
      return { name, target: "", code: JSON.stringify(args, null, 2) };
  }
}
