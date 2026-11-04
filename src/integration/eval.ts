import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { AstuteChatApi } from "../extension";

interface Task {
  name: string;
  prompt: string;
  verify: string;
}

const TASKS: Task[] = [
  {
    name: "c-library",
    prompt: "Write a C static library with an add function and build it into libadd.a",
    verify: `L=$(find . -name libadd.a | head -1); test -s "$L" && ar t "$L" | grep -q '.o' && printf 'int add(int,int);\\nint main(void){return add(2,3)==5?0:1;}\\n' > /tmp/astute_eval_$$.c && gcc /tmp/astute_eval_$$.c "$L" -o /tmp/astute_eval_$$ && /tmp/astute_eval_$$`,
  },
  {
    name: "cpp-library",
    prompt: "Write a C++ static library with a Stack class that has push and pop for ints, and build it into libstack.a",
    verify: `L=$(find . -name libstack.a | head -1); test -s "$L" && ar t "$L" | grep -q '.o' && nm -C "$L" | grep -q 'Stack::push'`,
  },
  {
    name: "python-package",
    prompt: "Write a Python package named calc with an add function and a pytest test for it, then run the tests.",
    verify: `test -f calc/__init__.py -o -f src/calc/__init__.py && P=.venv/bin/python; test -x $P || P=python3; find . -name 'test_*.py' -not -path './.venv/*' | grep -q . && $P -m pytest -q 2>&1 | grep -qE '[0-9]+ passed'`,
  },
];

/** Compares real tasks with and without language skills. The results go to a file. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<AstuteChatApi>("AstuteSystems.astute-chat-ollama");
  if (!extension) {
    throw new Error("extension missing");
  }
  const api = await extension.activate();
  const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath as string;
  const output = process.env.ASTUTE_EVAL_OUT as string;
  const config = vscode.workspace.getConfiguration("astuteChat");
  const repeats = Number(process.env.ASTUTE_EVAL_RUNS ?? 3);

  for (const model of (process.env.ASTUTE_EVAL_MODELS ?? "qwen3:8b").split(",")) {
    await config.update("model", model, vscode.ConfigurationTarget.Global);
    for (const task of TASKS) {
      for (const skills of [false, true]) {
        await config.update("languageSkills", skills, vscode.ConfigurationTarget.Global);
        for (let attempt = 0; attempt < repeats; attempt += 1) {
          for (const entry of fs.readdirSync(root)) {
            fs.rmSync(path.join(root, entry), { recursive: true, force: true });
          }
          const tools: string[] = [];
          let passed = false;
          let error = "";
          const started = Date.now();
          try {
            await Promise.race([
              api.service.runTurn({
                prompt: task.prompt,
                history: [],
                mode: "agent",
                confirm: async () => true,
                events: { onStatus: () => undefined, onThinking: () => undefined, onContent: () => undefined, onTool: (text) => tools.push(text.split("(")[0]), onNotice: () => undefined },
              }),
              new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 120000)),
            ]);
            execSync(task.verify, { cwd: root, shell: "/bin/bash", timeout: 30000, stdio: "ignore" });
            passed = true;
          } catch (failure) {
            error = String(failure).slice(0, 80);
          }
          fs.appendFileSync(output, `${JSON.stringify({ model, task: task.name, skills, passed, tools: tools.length, seconds: Math.round((Date.now() - started) / 1000), error })}\n`);
        }
      }
    }
  }
}
