import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { isInside, isSensitivePath } from "./pathGuard";

export const PLAN_HEADINGS = ["Goal", "Files", "Steps", "Verify", "Risks", "Open questions"];

const MAX_TRACKED_FILES = 40;
const QUOTED_PATH = /`([^`\s]+)`/;
const BARE_PATH = /[\w@.-]+(?:\/[\w@.-]+)+|[\w@-]+\.[A-Za-z]\w*/;
const TOP_LEVEL_STEP = /^ ?(?:\*\*)?(?:step\s+)?\d+[.):]\s*/i;
const NOTHING = /^(none|n\/a|no|nothing)\b[.!]?$/i;

/** The lines under a heading as written. Models vary the level and add colons, so neither matters. */
function rawSection(plan: string, heading: string): string[] | undefined {
  const lines = plan.split("\n");
  const wanted = new RegExp(`^#{1,6}\\s*${heading}\\s*:?\\s*$`, "i");
  const start = lines.findIndex((line) => wanted.test(line.trim()));
  if (start < 0) {
    return undefined;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}\s/.test(line.trim()));
  return end < 0 ? rest : rest.slice(0, end);
}

function sectionLines(plan: string, heading: string): string[] | undefined {
  return rawSection(plan, heading)?.map((line) => line.trim()).filter(Boolean);
}

/** A reply is a plan if it has steps. Anything else is a question or a remark, with nothing to implement. */
export function isPlan(text: string): boolean {
  return !!sectionLines(text, "Steps")?.length;
}

export function openQuestions(plan: string): string[] {
  return (sectionLines(plan, "Open questions") ?? []).map((line) => line.replace(/^([-*]|\d+[.)])\s+/, "").replace(/\*\*/g, "").trim()).filter((line) => line && !NOTHING.test(line));
}

/** Bold is fine in a plan, but it's noise in a step's label. */
function plainStep(line: string): string {
  return line.replace(/\*\*/g, "").trim();
}

/**
 * What to do, in order: each top-level numbered step with the lines under it, then
 * Verify. A plan with no numbered steps is carried out as one step.
 */
export function planSteps(plan: string): string[] {
  const steps: string[] = [];
  for (const line of rawSection(plan, "Steps") ?? []) {
    const numbered = TOP_LEVEL_STEP.exec(line);
    if (numbered) {
      steps.push(plainStep(line.slice(numbered[0].length)));
    } else if (steps.length && line.trim()) {
      steps[steps.length - 1] += `\n${plainStep(line)}`;
    }
  }
  const verify = (sectionLines(plan, "Verify") ?? []).filter((line) => !NOTHING.test(line));
  return [...(steps.length ? steps : ["Carry out the whole plan."]), ...(verify.length ? [`Check the finished work: ${verify.join(" ")}`] : [])];
}

export interface StepResult {
  failure?: string;
  cancelled?: boolean;
  denied?: boolean;
  usedTools?: boolean;
  unresolvedFailure?: boolean;
  hitToolLimit?: boolean;
  reply: string;
}

/** Why a step can't count as done, judged from what happened and not from what the model claims. */
export function stepProblem(step: StepResult): string | undefined {
  if (step.failure) {
    return step.failure;
  }
  if (step.cancelled) {
    return "You stopped it.";
  }
  if (step.denied) {
    return "A change was denied.";
  }
  if (step.unresolvedFailure) {
    return "A command or edit was still failing.";
  }
  if (step.hitToolLimit) {
    return "It ran out of tool rounds.";
  }
  if (!step.usedTools) {
    return step.reply.trim().endsWith("?") ? "The model has a question." : "The model didn't use any tools, so nothing was done.";
  }
  return step.reply.trim().endsWith("?") ? "The model has a question." : undefined;
}

/** The files a plan lists, and whether each is marked as new. */
export function planFiles(plan: string): Array<{ file: string; isNew: boolean }> {
  return (sectionLines(plan, "Files") ?? []).flatMap((line) => {
    const match = QUOTED_PATH.exec(line) ?? BARE_PATH.exec(line);
    if (!match) {
      return [];
    }
    const file = (match[1] ?? match[0]).replace(/^\.\//, "");
    return [{ file, isNew: /\bnew\b/i.test(line.replace(match[0], "")) }];
  });
}

/** Undefined for a path outside the workspace, or one that may hold a secret, so neither is read. */
function workspacePath(root: string, file: string): string | undefined {
  const full = path.resolve(root, file);
  return isInside(root, full) && !isSensitivePath(full) ? full : undefined;
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

/** What's wrong with a plan, checked here because models ignore prompts and report success anyway. */
export async function planProblems(reply: string, root: string | undefined): Promise<string[]> {
  const hasHeadings = /^#{1,6}\s/m.test(reply);
  if (!hasHeadings && reply.includes("?")) {
    return [];
  }
  const missing = PLAN_HEADINGS.filter((heading) => !sectionLines(reply, heading));
  const problems = missing.length ? [`These headings are missing: ${missing.join(", ")}.`] : [];
  if (root) {
    for (const { file, isNew } of planFiles(reply)) {
      const full = workspacePath(root, file);
      if (full) {
        const found = await exists(full);
        if (found && isNew) {
          problems.push(`${file} is marked as new, but it already exists.`);
        } else if (!found && !isNew) {
          problems.push(`${file} doesn't exist. Use the right path, or mark it as new.`);
        }
      }
    }
  }
  return problems;
}

async function hashFile(file: string): Promise<string | null> {
  const text = await fs.readFile(file).catch(() => undefined);
  return text ? createHash("sha256").update(text).digest("hex") : null;
}

/**
 * Records the planned files as they are now. Hashes work without Git and don't
 * mistake edits that were already there when the plan was written for later ones.
 */
export async function hashPlanFiles(plan: string, root: string): Promise<Record<string, string | null>> {
  const hashes: Record<string, string | null> = {};
  for (const { file } of planFiles(plan).slice(0, MAX_TRACKED_FILES)) {
    const full = workspacePath(root, file);
    if (full) {
      hashes[file] = await hashFile(full);
    }
  }
  return hashes;
}

export async function changedPlanFiles(hashes: Readonly<Record<string, string | null>>, root: string): Promise<string[]> {
  const changed: string[] = [];
  for (const [file, hash] of Object.entries(hashes)) {
    const full = workspacePath(root, file);
    if (full && (await hashFile(full)) !== hash) {
      changed.push(file);
    }
  }
  return changed;
}
