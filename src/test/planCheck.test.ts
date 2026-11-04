import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { MODES } from "../modes";
import { changedPlanFiles, hashPlanFiles, isPlan, openQuestions, PLAN_HEADINGS, planFiles, planProblems, planSteps, stepProblem } from "../planCheck";

const plan = (files: string, questions = "None") => `## Goal\nCache\n\n## Files\n${files}\n\n## Steps\n1. Do it\n\n## Verify\nRun tests\n\n## Risks\nNone\n\n## Open questions\n${questions}`;

function workspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "astute-plan-")));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "a");
  return root;
}

test("the headings checked are the ones Plan is told to write", () => {
  PLAN_HEADINGS.forEach((heading) => assert.ok(MODES.plan.instructions.includes(`## ${heading}`), heading));
});

test("a reply is a plan only if it has steps", () => {
  assert.equal(isPlan(plan("- a.ts")), true);
  assert.equal(isPlan("Which database do you use?"), false);
  assert.equal(isPlan("## Goal\nCache\n\n## Steps\n\n## Verify\nx"), false);
});

test("reads how models really write a Files list", () => {
  assert.deepEqual(planFiles(plan("- src/a.ts\n- `src/b.ts` (new)\n*   **New:** src/c.ts\n- ./Makefile.am: rules\n- `Makefile`\n- None")), [
    { file: "src/a.ts", isNew: false },
    { file: "src/b.ts", isNew: true },
    { file: "src/c.ts", isNew: true },
    { file: "Makefile.am", isNew: false },
    { file: "Makefile", isNew: false },
  ]);
});

test("a folder called new doesn't mark a file as new", () => {
  assert.deepEqual(planFiles(plan("- src/new/a.ts")), [{ file: "src/new/a.ts", isNew: false }]);
});

test("accepts a sound plan", async () => {
  assert.deepEqual(await planProblems(plan("- `src/a.ts`\n- src/b.ts (new)"), workspace()), []);
});

test("finds an existing file marked as new, as llama3.1 did", async () => {
  assert.deepEqual(await planProblems(plan("- src/a.ts (new)"), workspace()), ["src/a.ts is marked as new, but it already exists."]);
});

test("finds a file that doesn't exist", async () => {
  assert.deepEqual(await planProblems(plan("- src/invented.ts"), workspace()), ["src/invented.ts doesn't exist. Use the right path, or mark it as new."]);
});

test("names missing headings", async () => {
  assert.deepEqual(await planProblems("## Goal\nCache\n\n## Steps\n1. x", undefined), ["These headings are missing: Files, Verify, Risks, Open questions."]);
  assert.deepEqual(await planProblems("Just change the client.", undefined), [`These headings are missing: ${PLAN_HEADINGS.join(", ")}.`]);
});

test("accepts headings written another way", async () => {
  assert.deepEqual(await planProblems(plan("- x").replace("## Goal", "### goal:").replace("## Risks", "# RISKS"), undefined), []);
});

test("a plain question isn't a failed plan", async () => {
  assert.deepEqual(await planProblems("Which database do you use?", undefined), []);
});

test("doesn't look outside the workspace or at secret files", async () => {
  assert.deepEqual(await planProblems(plan("- `../../etc/passwd`\n- `/etc/passwd`\n- `.env`"), workspace()), []);
});

test("without a workspace, only the shape is checked", async () => {
  assert.deepEqual(await planProblems(plan("- src/invented.ts"), undefined), []);
});

test("finds real open questions", () => {
  for (const none of ["None", "None.", "- None", "N/A", "**None**", ""]) {
    assert.deepEqual(openQuestions(plan("- a.ts", none)), [], none);
  }
  assert.deepEqual(openQuestions(plan("- a.ts", "1. Which size?\n- **Which store?**")), ["Which size?", "Which store?"]);
  assert.deepEqual(openQuestions("## Goal\nx"), []);
});

test("notices changed, created and deleted files, and nothing else", async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "src", "same.ts"), "same");
  fs.writeFileSync(path.join(root, "src", "gone.ts"), "gone");
  const hashes = await hashPlanFiles(plan("- src/a.ts\n- src/same.ts\n- src/gone.ts\n- src/b.ts (new)"), root);
  assert.deepEqual(await changedPlanFiles(hashes, root), []);
  fs.writeFileSync(path.join(root, "src", "a.ts"), "edited");
  fs.rmSync(path.join(root, "src", "gone.ts"));
  fs.writeFileSync(path.join(root, "src", "b.ts"), "made by someone else");
  assert.deepEqual((await changedPlanFiles(hashes, root)).sort(), ["src/a.ts", "src/b.ts", "src/gone.ts"]);
});

test("never hashes a secret or a file outside the workspace", async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  assert.deepEqual(await hashPlanFiles(plan("- `.env`\n- `../outside.ts`"), root), {});
  assert.deepEqual(await changedPlanFiles({ ".env": null, "../outside.ts": null }, root), []);
});

test("reads steps as models write them, with Verify last", () => {
  const text = "## Steps\n1. First\n   - detail\n   1. nested\n2) Second\n**3.** Third\nStep 4: Fourth\n\n## Verify\nRun tests.\n";
  assert.deepEqual(planSteps(text), ["First\n- detail\n1. nested", "Second", "Third", "Fourth", "Check the finished work: Run tests."]);
});

test("a plan with no numbered steps runs as one step", () => {
  assert.deepEqual(planSteps("## Steps\n- Do the thing"), ["Carry out the whole plan."]);
});

test("a Verify of None adds no step", () => {
  assert.deepEqual(planSteps("## Steps\n1. One\n\n## Verify\nNone"), ["One"]);
});

test("a step finishes only if tools ran and nothing is left wrong", () => {
  assert.equal(stepProblem({ usedTools: true, reply: "Done." }), undefined);
  assert.match(stepProblem({ usedTools: false, reply: "Done." }) ?? "", /didn't use any tools/);
  assert.match(stepProblem({ usedTools: true, unresolvedFailure: true, reply: "Done." }) ?? "", /still failing/);
  assert.match(stepProblem({ usedTools: true, hitToolLimit: true, reply: "Done." }) ?? "", /tool rounds/);
  assert.match(stepProblem({ usedTools: true, denied: true, reply: "Done." }) ?? "", /denied/);
  assert.match(stepProblem({ usedTools: true, reply: "Shall I go on?" }) ?? "", /question/);
  assert.match(stepProblem({ usedTools: false, reply: "Which one?" }) ?? "", /question/);
  assert.equal(stepProblem({ failure: "Boom.", usedTools: true, reply: "" }), "Boom.");
  assert.match(stepProblem({ cancelled: true, usedTools: true, reply: "" }) ?? "", /stopped/);
});

test("drops bold from steps, as gemma3 writes them", () => {
  assert.deepEqual(planSteps("## Steps\n1.  **Modify `a.ts`:** Add a retry.\n"), ["Modify `a.ts`: Add a retry."]);
});
