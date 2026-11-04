import * as assert from "node:assert/strict";
import { test } from "node:test";
import { describeHost, parseOsRelease } from "../hostInfo";

test("reads the distribution name", () => {
  assert.equal(parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 26.04 LTS"\nID=ubuntu\n'), "Ubuntu 26.04 LTS");
  assert.equal(parseOsRelease("PRETTY_NAME=Arch\n"), "Arch");
  assert.equal(parseOsRelease("ID=x\n"), undefined);
});

test("describes each system and tells the model to stick to it", () => {
  assert.match(describeHost("linux", "x64", "Ubuntu 26.04 LTS", "/usr/bin/bash"), /Ubuntu 26\.04 LTS, Linux x64 with the bash shell\. Give commands .* for this system only/);
  assert.match(describeHost("darwin", "arm64", undefined, "/bin/zsh"), /is macOS arm64 with the zsh shell/);
  assert.match(describeHost("win32", "x64", undefined, "C:\\Windows\\powershell.exe"), /is Windows x64 with the powershell\.exe shell/);
  assert.match(describeHost("linux", "x64", "Arch Linux", ""), /is Arch Linux x64\./);
});
