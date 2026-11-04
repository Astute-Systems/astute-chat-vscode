import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { describeLocation, findRepo } from "../repoInfo";

function repo(branchHead: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "astute-repo-")));
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "src/deep"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git/HEAD"), branchHead);
  return root;
}

test("finds the repository root and branch from a subfolder", async () => {
  const root = repo("ref: refs/heads/feature/i2c\n");
  assert.deepEqual(await findRepo(path.join(root, "src/deep")), { root, branch: "feature/i2c" });
});

test("handles a detached HEAD, and worktrees", async () => {
  assert.equal((await findRepo(repo("3b746a6\n")))?.branch, undefined);
  const main = repo("ref: refs/heads/main\n");
  fs.mkdirSync(path.join(main, ".git/worktrees/w"), { recursive: true });
  fs.writeFileSync(path.join(main, ".git/worktrees/w/HEAD"), "ref: refs/heads/wt\n");
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "astute-tree-"));
  fs.writeFileSync(path.join(tree, ".git"), `gitdir: ${path.join(main, ".git/worktrees/w")}\n`);
  assert.equal((await findRepo(tree))?.branch, "wt");
});

test("describes where work happens", () => {
  assert.deepEqual(describeLocation(["/r"], { root: "/r", branch: "main" }), ["Workspace root: /r. Relative paths and commands run from here.", "Git repository root: the workspace root, on branch main."]);
  assert.match(describeLocation(["/r/pkg"], { root: "/r", branch: "main" })[1], /Git repository root: \/r, on branch main/);
  assert.match(describeLocation(["/r"], { root: "/r" })[1], /detached HEAD/);
  assert.match(describeLocation(["/r"], undefined)[1], /not in a Git repository/);
  assert.match(describeLocation(["/a", "/b"], undefined)[1], /Other workspace folders: \/b/);
  assert.deepEqual(describeLocation([], undefined), ["No folder is open."]);
});
