import { DUMMY_FILE_RULE } from "./contentGuardRule";

/** Without this, models rewrote paths for MCP tools as workspace paths, and gave up when they were refused. */
export const MCP_RULE = "Tools named mcp_ belong to external servers and aren't limited to the workspace. Pass paths and other values to them exactly as the user wrote them, including absolute paths. If one refuses a value, read the error, correct the value and try again. Then answer using what the tool returned.";

export type ChatMode = "ask" | "plan" | "agent";

export interface ModeDefinition {
  id: ChatMode;
  label: string;
  placeholder: string;
  /** Only modes with this set are offered tools that change anything. */
  canChange: boolean;
  requiresTools: boolean;
  maxToolRounds: number;
  instructions: string;
  /**
   * Added to the latest request only. Without this, short requests such as
   * "Build library" got explanations instead of tool calls. Models must also be
   * allowed to ask, or an unclear request pushes them to invent sample code.
   */
  requestReminder?: string;
  /** Sent once if the model replies without using a tool. */
  retryPrompt?: string;
  /** Sent when a reply ends while the last command is still failing. */
  fixPrompt?: string;
}

export const MODES: Record<ChatMode, ModeDefinition> = {
  ask: {
    id: "ask",
    label: "Ask",
    placeholder: "Ask about this workspace. Type /help for commands.",
    canChange: false,
    requiresTools: false,
    maxToolRounds: 6,
    instructions: "You are in Ask mode. Answer the question directly. You can read the workspace and run read-only checks with probe_command, including git and system information, so check facts yourself and don't ask the user to. You can't change anything in this mode. If the user asks you to do something that changes the workspace or the system, such as committing or restarting a service, tell them in one sentence to switch to Agent mode. Never say that you changed something.",
  },
  plan: {
    id: "plan",
    label: "Plan",
    placeholder: "Describe what you want to build or change.",
    canChange: false,
    requiresTools: false,
    maxToolRounds: 10,
    instructions:
      "You are in Plan mode. Research the workspace, then write a numbered implementation plan. Name the files to change, the steps in order, how to verify the work and any risks. Use probe_command for git and system facts. Do not write the full implementation, and never say that you changed something. You cannot change the workspace in this mode.",
  },
  agent: {
    id: "agent",
    label: "Agent",
    placeholder: "Describe the task. You approve each change.",
    canChange: true,
    requiresTools: true,
    maxToolRounds: 20,
    requestReminder: "\n\nIf this says exactly what to create or which code to build, do it now in the open workspace by calling your tools, and do not explain how. If it does not, look at the workspace with your tools, then ask one short question instead. Do not invent sample code.",
    fixPrompt: "The last command failed, so the task isn't finished. Fix the cause and run it again. If you can't fix it, say exactly what failed and why.",
    retryPrompt: "You did not call a tool, so nothing was done in the workspace. Call a tool now to do the task, or ask one short question if you need more detail. Do not explain how to do it.",
    instructions:
      "You are in Agent mode on the user's machine. You can run shell commands, so never say you can't, and never give the user commands to run themselves. Do the work: use run_command for git, builds, packages and services, and probe_command to check the result. Commands can't answer prompts, so sudo only works if it needs no password; if a command fails for that reason, say so. Complete the task by using your tools. Read a file before you change it, and prefer edit_file for small changes. The user approves each change. If a change is denied, do not repeat it: find another approach or stop and explain. When you finish, summarise what changed and how it was checked. " + DUMMY_FILE_RULE,
  },
};

export function isChatMode(value: unknown): value is ChatMode {
  return value === "ask" || value === "plan" || value === "agent";
}

export type ApprovalLevel = "ask" | "edits" | "auto" | "full";

export interface ApprovalDefinition {
  id: ApprovalLevel;
  label: string;
  description: string;
}

/** The order here is the order Shift+Tab cycles through. "full" has its own toggle instead. */
export const APPROVALS: ApprovalDefinition[] = [
  { id: "ask", label: "Ask first", description: "Asks before every file change and command." },
  { id: "edits", label: "Auto-edit", description: "Approves ordinary file edits and pauses for sensitive files. Commands still ask." },
  { id: "auto", label: "Safe auto", description: "Approves actions that pass a safety check and pauses for anything risky." },
];

export function isApprovalLevel(value: unknown): value is ApprovalLevel {
  return value === "ask" || value === "edits" || value === "auto" || value === "full";
}
