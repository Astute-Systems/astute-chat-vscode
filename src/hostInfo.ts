import * as fs from "fs";
import * as os from "os";

const PLATFORM_NAMES: Record<string, string> = { linux: "Linux", darwin: "macOS", win32: "Windows" };

/** Reads the distribution name from the contents of /etc/os-release. */
export function parseOsRelease(text: string): string | undefined {
  return text.match(/^PRETTY_NAME=["']?([^"'\n]+)/m)?.[1]?.trim();
}

/** A sentence for the system prompt. Models otherwise cover every platform. */
export function describeHost(platform: string, arch: string, distribution: string | undefined, shell: string): string {
  const name = PLATFORM_NAMES[platform] ?? platform;
  const system = distribution && !distribution.toLowerCase().includes(name.toLowerCase()) ? `${distribution}, ${name} ${arch}` : `${distribution ?? name} ${arch}`;
  const shellName = shell.split(/[\\/]/).pop();
  const named = shellName ? ` with the ${shellName} shell` : "";
  return `The user's system is ${system}${named}. Give commands and instructions for this system only, not for other operating systems, unless the user asks.`;
}

/** Describes the machine the extension runs on, which is where commands run. */
export function hostDescription(shell: string): string {
  let distribution: string | undefined;
  try {
    distribution = process.platform === "linux" ? parseOsRelease(fs.readFileSync("/etc/os-release", "utf8")) : undefined;
  } catch {
    // Older systems may not have this file.
  }
  return describeHost(process.platform, os.arch(), distribution, shell);
}
