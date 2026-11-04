#!/usr/bin/env node
// Publishes to the Marketplace with the token in .env, so nothing has to read the
// token into a prompt or a command line. An agent can run this without seeing it.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
let token = "";
try {
  token = /^AZURE-PAT=(.*)$/m.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1].trim() ?? "";
} catch {
  // Reported below.
}
if (!token) {
  console.error("No AZURE-PAT line was found in .env.");
  process.exit(1);
}

const vsce = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
const result = spawnSync(vsce, ["publish", "--no-dependencies"], { cwd: root, env: { ...process.env, VSCE_PAT: token }, encoding: "utf8", shell: process.platform === "win32" });
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.split(token).join("<token>");
console.log(output.trim());
process.exit(result.status ?? 1);
