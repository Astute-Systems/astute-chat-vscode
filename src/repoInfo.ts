import * as fs from "fs/promises";
import * as path from "path";

export interface RepoInfo {
  root: string;
  /** The branch name, or undefined on a detached HEAD. */
  branch?: string;
}

/** Reads the branch directly, so asking doesn't start a git process on every message. */
async function readBranch(root: string): Promise<string | undefined> {
  const dotGit = path.join(root, ".git");
  let gitDir = dotGit;
  if ((await fs.stat(dotGit)).isFile()) {
    // Worktrees and submodules use a .git file that points at the real folder.
    const pointer = (await fs.readFile(dotGit, "utf8")).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (pointer) {
      gitDir = path.resolve(root, pointer);
    }
  }
  return (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).match(/^ref: refs\/heads\/(.+)$/m)?.[1]?.trim();
}

/** Finds the repository that contains a folder, looking upwards as git does. */
export async function findRepo(folder: string): Promise<RepoInfo | undefined> {
  for (let current = folder; ; current = path.dirname(current)) {
    try {
      await fs.stat(path.join(current, ".git"));
      return { root: current, branch: await readBranch(current).catch(() => undefined) };
    } catch {
      if (path.dirname(current) === current) {
        return undefined;
      }
    }
  }
}

/** Says where work happens. Tools and commands run from the first folder. */
export function describeLocation(folders: readonly string[], repo: RepoInfo | undefined): string[] {
  if (folders.length === 0) {
    return ["No folder is open."];
  }
  const lines = [`Workspace root: ${folders[0]}. Relative paths and commands run from here.`];
  if (folders.length > 1) {
    lines.push(`Other workspace folders: ${folders.slice(1).join(", ")}.`);
  }
  if (repo) {
    const where = repo.root === folders[0] ? "the workspace root" : repo.root;
    lines.push(`Git repository root: ${where}, ${repo.branch ? `on branch ${repo.branch}` : "with a detached HEAD"}.`);
  } else {
    lines.push("The workspace root is not in a Git repository.");
  }
  return lines;
}
