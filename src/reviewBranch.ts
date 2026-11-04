import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 30000;
const MAX_SLUG_CHARS = 40;

export interface ReviewBranch {
  branch: string;
  base: string;
}

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", root, ...args], { timeout: GIT_TIMEOUT_MS });
  return stdout.trim();
}

async function succeeds(root: string, ...args: string[]): Promise<boolean> {
  return git(root, ...args).then(
    () => true,
    () => false,
  );
}

export function currentBranch(root: string): Promise<string | undefined> {
  return git(root, "symbolic-ref", "--short", "-q", "HEAD").catch(() => undefined);
}

export function branchSlug(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/^-+|-+$/g, "");
  return slug || "change";
}

/** Explains why review can't start, or returns undefined when it can. */
export async function reviewBlocker(root: string): Promise<string | undefined> {
  const branch = await currentBranch(root);
  if (!branch) {
    return "Review mode needs a Git branch, and this isn't on one.";
  }
  if (!(await succeeds(root, "rev-parse", "--verify", "HEAD"))) {
    return "Review mode needs at least one commit.";
  }
  // Uncommitted work would end up in Agent's commit, so it has to be dealt with first.
  if (await git(root, "status", "--porcelain", "--untracked-files=no")) {
    return "Review mode needs your changes committed or stashed first.";
  }
  return undefined;
}

export async function startReview(root: string, prompt: string): Promise<ReviewBranch> {
  const base = (await currentBranch(root)) as string;
  const slug = branchSlug(prompt);
  let branch = `astute/${slug}`;
  for (let suffix = 2; await succeeds(root, "rev-parse", "--verify", "-q", `refs/heads/${branch}`); suffix += 1) {
    branch = `astute/${slug}-${suffix}`;
  }
  await git(root, "switch", "-q", "-c", branch);
  return { branch, base };
}

/** Commits only the files Agent wrote, so unrelated files stay out of the commit. */
export async function commitReview(root: string, files: readonly string[], message: string): Promise<void> {
  for (const file of files) {
    await git(root, "add", "--", file).catch(() => undefined);
  }
  if (!(await succeeds(root, "diff", "--cached", "--quiet"))) {
    await git(root, "commit", "-q", "-m", message);
  }
}

export async function reviewFiles(root: string, review: ReviewBranch): Promise<string[]> {
  const output = await git(root, "diff", "--name-only", `${review.base}...${review.branch}`);
  return output ? output.split("\n") : [];
}

export function latestCommit(root: string): Promise<string> {
  return git(root, "rev-parse", "--short", "HEAD");
}

/** The text of a file on the base branch, or an empty string if it's new there. */
export function baseVersion(root: string, review: ReviewBranch, file: string): Promise<string> {
  return git(root, "show", `${review.base}:${file}`).catch(() => "");
}

export async function mergeReview(root: string, review: ReviewBranch): Promise<void> {
  await git(root, "switch", "-q", review.base);
  try {
    await git(root, "merge", "-q", "--no-edit", review.branch);
  } catch (error) {
    await git(root, "merge", "--abort").catch(() => undefined);
    throw error;
  }
  await git(root, "branch", "-q", "-d", review.branch);
}

export async function discardReview(root: string, review: ReviewBranch): Promise<void> {
  await git(root, "switch", "-q", review.base);
  await git(root, "branch", "-q", "-D", review.branch);
}

/** Removes a branch that ended up with no commits. */
export async function dropEmptyReview(root: string, review: ReviewBranch): Promise<void> {
  await discardReview(root, review);
}
