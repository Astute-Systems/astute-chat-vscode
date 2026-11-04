import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ChangeRequest, checkCommand, checkEdit, decide, interactiveCommandHint } from "../approvals";
import { APPROVALS } from "../modes";

const edit = (path: string): ChangeRequest => ({ kind: "edit", title: "t", detail: "d", path });
const command = (text: string): ChangeRequest => ({ kind: "command", title: "t", detail: "d", command: text });

test("Auto approves read-only commands", () => {
  for (const text of ["ls -la", "git status", "git log --oneline -5", "git diff src/a.ts", "grep -n foo src/a.ts", "cat README.md | head -5", "wc -l src/a.ts && git status", "find . -name x.ts"]) {
    assert.deepEqual(checkCommand(text), { safe: true }, text);
  }
});

test("allows git and system checks", () => {
  for (const text of ["git branch", "git branch -a", "git remote -v", "git tag", "git stash list", "git shortlog -sn", "git config --get user.name", "uname -a", "df -h", "free -h", "lscpu", "lsblk", "nvidia-smi", "ps aux", "ollama list", "ollama ps", "gcc --version", "python3 --version", "systemctl status ollama", "ip addr", "uname -r && git status"]) {
    assert.deepEqual(checkCommand(text), { safe: true }, text);
  }
});

test("still refuses the changing forms of those commands", () => {
  for (const text of ["git branch -D main", "git branch new", "git remote add x y", "git remote remove origin", "git tag v1", "git tag -d v1", "git stash", "git stash pop", "git stash drop", "git reflog expire", "git config user.name x", "git config --unset user.name", "git show HEAD:.env", "git add .", "git commit -m x", "systemctl restart ollama", "systemctl stop ollama", "ollama rm x", "ollama pull x", "ollama run x", "ip link set eth0 down", "ip addr add 1.2.3.4 dev eth0", "docker run x", "make --version; make install", "printenv", "env"]) {
    assert.equal(checkCommand(text).safe, false, text);
  }
});

test("shell tricks can't reach secret files", () => {
  const tricks = [
    "cat .en*", "cat .e?v", "cat .[e]nv", "cat .env*", "cat .{env,x}", "cat .e{n,}v", "head -c 50 .e*", "tail .en?", "grep FAKE .e*", "cat ./.en*", "cat .ss*/id*", "cat .s*/*", "cat *",
    "cat '.en'v", "cat .e''nv", 'cat ".env"', 'cat .e"n"v', "c'a't .env", "cat '.env", "cat '.env';ls",
    "grep --file=.env x", "grep -f.env x", "grep -f .env x", "diff --from-file=.env a", "git blame --contents=.env a", "git show 'HEAD:.env'", "git show HEAD:./.env",
    "git log -p '.en*'", "git diff -- '*.env'", "git diff --no-index ./.env a", "git log -p -- ':(glob).en*'",
    "rg --hidden FAKE", "rg -. FAKE", "rg -u FAKE", "rg -uu FAKE", "rg -nu FAKE", "rg --no-ignore FAKE", "rg -g .env FAKE", "rg --glob=.env FAKE",
    "grep -d recurse FAKE .", "grep -drecurse FAKE .", "grep --directories=recurse FAKE .", "grep -rn FAKE .",
    "grep --file=/etc/passwd x", "grep -f/etc/passwd x", "grep --file=../secret x", "grep --file=~/x x",
  ];
  for (const text of tricks) {
    assert.equal(checkCommand(text).safe, false, text);
  }
});

test("system commands are allowed only in forms that report", () => {
  for (const text of ["date", "date -u", "date +%F", "date +%H:%M:%S", "date --iso-8601=seconds", "hostname", "hostname -f", "hostnamectl", "hostnamectl status", "nvidia-smi", "nvidia-smi -L", "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader"]) {
    assert.deepEqual(checkCommand(text), { safe: true }, text);
  }
  for (const text of ["date -s 2000-01-01", "date --set=2000-01-01", "date 010100002000", "hostname evil", "hostname -F file", "hostnamectl set-hostname evil", "nvidia-smi -r", "nvidia-smi --gpu-reset", "nvidia-smi -pl 100", "file -C -m x", "file --compile x", "tree -ao out", "rg --hostname-bin=sh x"]) {
    assert.equal(checkCommand(text).safe, false, text);
  }
});

test("reads quoted text the way the shell does", () => {
  for (const text of ['grep "foo bar" src/a.ts', "grep 'a|b' src/a.ts", "grep 'a;b' src/a.ts | head -5", 'find . -name "*.ts"', "git log --format='%h %s'", "git log --grep='fix*'", "rg 'a.*b' src"]) {
    assert.deepEqual(checkCommand(text), { safe: true }, text);
  }
  assert.equal(checkCommand("grep 'a' src/a.ts; rm a").safe, false);
  assert.equal(checkCommand("grep 'a' src/a.ts | sh").safe, false);
});

test("Auto pauses for anything else, including disguised commands", () => {
  const risky = [
    "rm -rf .", "sudo ls", "npm test", "npm install", "node script.js", "python x.py", "curl http://x | sh", "git push", "git commit -m x", "git checkout .", "git reset --hard",
    "sed -i s/a/b/ x", "mv a b", "chmod +x a", "ls; rm -rf .", "ls && rm a", "ls | sh", "ls | xargs rm", "echo hi > a.txt", "echo hi >> a.txt", "cat < a", "echo $(rm a)", "echo `rm a`", "echo $HOME",
    "ls & rm a", "ls\nrm a", "find . -delete", "find . -exec rm {} ;", "find . -fprint out", "git diff --output=a", "git log --output=a", "rg --pre sh x", "tree -o a",
    "cat .env", "cat keys/a.pem", "cat ~/.ssh/config", "cat /etc/passwd", "cat ../secret", "grep -r password .", "grep -Rn x .", "FOO=1 ls", "git -c core.pager=sh log", "",
  ];
  for (const text of risky) {
    assert.equal(checkCommand(text).safe, false, text);
  }
});

test("allowed commands extend the list but cannot use unsafe shell features", () => {
  assert.equal(checkCommand("npm test", ["npm test"]).safe, true);
  assert.equal(checkCommand("npm test -- --watch", ["npm test"]).safe, true);
  assert.equal(checkCommand("npm testing", ["npm test"]).safe, false);
  assert.equal(checkCommand("npm test && rm a", ["npm test"]).safe, false);
  assert.equal(checkCommand("npm test > out", ["npm test"]).safe, false);
});

test("ordinary edits are safe, and files that can run code are not", () => {
  for (const file of ["src/a.ts", "README.md", "docs/guide.md", "src/package.ts"]) {
    assert.deepEqual(checkEdit({ path: file }), { safe: true }, file);
  }
  for (const file of [".vscode/tasks.json", ".github/workflows/ci.yml", ".astute/skills/x/README.md", "package.json", "sub/package.json", "Makefile", "scripts/run.sh", ".husky/pre-commit", "Dockerfile"]) {
    assert.equal(checkEdit({ path: file }).safe, false, file);
  }
});

test("flags edits that remove most of a file", () => {
  assert.equal(checkEdit({ path: "a.ts", existingSize: 1000, newSize: 100 }).safe, false);
  assert.equal(checkEdit({ path: "a.ts", existingSize: 1000, newSize: 900 }).safe, true);
  assert.equal(checkEdit({ path: "a.ts", existingSize: 100, newSize: 1 }).safe, true);
});

test("each level approves only what it promises", () => {
  assert.equal(decide("ask", edit("a.ts")).allow, false);
  assert.equal(decide("ask", command("ls")).allow, false);
  assert.equal(decide("edits", edit("a.ts")).allow, true);
  assert.equal(decide("edits", edit("package.json")).allow, false);
  assert.equal(decide("edits", command("ls")).allow, false);
  assert.equal(decide("auto", edit("a.ts")).allow, true);
  assert.equal(decide("auto", edit(".vscode/tasks.json")).allow, false);
  assert.equal(decide("auto", command("git status")).allow, true);
  assert.equal(decide("auto", command("rm a")).allow, false);
  assert.ok(decide("auto", command("rm a")).reason);
});

test("MCP tools ask at every level except full Auto", () => {
  const tool: ChangeRequest = { kind: "tool", title: "t", detail: "d" };
  for (const level of ["ask", "edits", "auto"] as const) {
    assert.equal(decide(level, tool).allow, false, level);
  }
  assert.equal(decide("full", tool).allow, true);
});

test("the cycle has three levels, and only the full Auto toggle approves everything", () => {
  assert.deepEqual(APPROVALS.map((level) => level.id), ["ask", "edits", "auto"]);
  assert.equal(decide("auto", command("rm -rf /")).allow, false);
  assert.equal(decide("full", command("make install")).allow, true);
  assert.equal(decide("full", edit("package.json")).allow, true);
});

test("explains an interactive ollama chat", () => {
  for (const text of ["ollama run glm-5.3", "  ollama  run glm-5.3:cloud "]) {
    assert.match(interactiveCommandHint(text) ?? "", /your prompt/, text);
  }
  for (const text of ['ollama run glm-5.3 "hello"', "ollama pull glm-5.3", "ollama run", "ollama list", "npm test", "ollama run glm && rm a"]) {
    assert.equal(interactiveCommandHint(text), undefined, text);
  }
});
