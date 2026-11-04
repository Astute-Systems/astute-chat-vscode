import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { baseVersion, branchSlug, commitReview, currentBranch, discardReview, mergeReview, reviewBlocker, reviewFiles, startReview } from "../reviewBranch";

function repo(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "astute-review-")));
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  fs.writeFileSync(path.join(root, "a.c"), "int a;\n");
  git("add", ".");
  git("commit", "-qm", "start");
  return root;
}

test("makes readable branch names", () => {
  assert.equal(branchSlug("Fix the I2C driver!"), "fix-the-i2c-driver");
  assert.equal(branchSlug("!!!"), "change");
  assert.ok(branchSlug("x".repeat(100)).length <= 40);
});

test("won't start with uncommitted work, on a detached HEAD or with no commits", async () => {
  const root = repo();
  assert.equal(await reviewBlocker(root), undefined);
  fs.writeFileSync(path.join(root, "untracked.txt"), "fine");
  assert.equal(await reviewBlocker(root), undefined, "untracked files don't block");
  fs.writeFileSync(path.join(root, "a.c"), "changed\n");
  assert.match((await reviewBlocker(root)) ?? "", /committed or stashed/);
  execFileSync("git", ["checkout", "-q", "--", "a.c"], { cwd: root });
  execFileSync("git", ["checkout", "-q", "--detach"], { cwd: root });
  assert.match((await reviewBlocker(root)) ?? "", /branch/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "astute-empty-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: empty });
  assert.match((await reviewBlocker(empty)) ?? "", /one commit/);
});

test("keeps Agent's work on a branch, and leaves the base alone", async () => {
  const root = repo();
  const review = await startReview(root, "Add b");
  assert.deepEqual(review, { branch: "astute/add-b", base: "main" });
  fs.writeFileSync(path.join(root, "b.c"), "int b;\n");
  fs.writeFileSync(path.join(root, "junk.o"), "x");
  await commitReview(root, ["b.c"], "Astute Agent: Add b");
  assert.deepEqual(await reviewFiles(root, review), ["b.c"], "only Agent's files are committed");
  assert.equal(await baseVersion(root, review, "a.c"), "int a;");
  assert.equal(await baseVersion(root, review, "b.c"), "");
  assert.equal((await startReview(root, "Add b")).branch, "astute/add-b-2");
});

test("merges into the base and removes the branch", async () => {
  const root = repo();
  const review = await startReview(root, "merge me");
  fs.writeFileSync(path.join(root, "b.c"), "int b;\n");
  await commitReview(root, ["b.c"], "add");
  await mergeReview(root, review);
  assert.equal(await currentBranch(root), "main");
  assert.ok(fs.existsSync(path.join(root, "b.c")));
  assert.ok(!execFileSync("git", ["branch"], { cwd: root }).toString().includes("astute/"));
});

test("discards the work and returns to the base", async () => {
  const root = repo();
  const review = await startReview(root, "throw away");
  fs.writeFileSync(path.join(root, "b.c"), "int b;\n");
  await commitReview(root, ["b.c"], "add");
  await discardReview(root, review);
  assert.equal(await currentBranch(root), "main");
  assert.ok(!fs.existsSync(path.join(root, "b.c")));
});

test("a merge conflict leaves the repository clean, and the branch in place", async () => {
  const root = repo();
  const review = await startReview(root, "conflict");
  fs.writeFileSync(path.join(root, "a.c"), "agent\n");
  await commitReview(root, ["a.c"], "agent");
  execFileSync("git", ["switch", "-q", "main"], { cwd: root });
  fs.writeFileSync(path.join(root, "a.c"), "human\n");
  execFileSync("git", ["commit", "-qam", "human"], { cwd: root });
  execFileSync("git", ["switch", "-q", review.branch], { cwd: root });
  await assert.rejects(mergeReview(root, review));
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString(), "");
  assert.equal(fs.readFileSync(path.join(root, "a.c"), "utf8"), "human\n");
  assert.ok(execFileSync("git", ["branch"], { cwd: root }).toString().includes("astute/conflict"));
});
