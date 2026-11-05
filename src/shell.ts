import { spawn } from "child_process";

const MAX_OUTPUT_CHARS = 200000;
const KILL_GRACE_MS = 2000;

export interface ShellResult {
  output: string;
  exitCode: number | null;
  stopped: boolean;
  timedOut: boolean;
}

/**
 * Runs a command in its own process group, so stopping it also stops anything
 * it started. Killing only the shell would leave those processes running.
 */
export function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stopped = false;
    let timedOut = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const send = (name: NodeJS.Signals): void => {
      try {
        if (process.platform === "win32" || child.pid === undefined) {
          child.kill(name);
        } else {
          process.kill(-child.pid, name);
        }
      } catch {
        // The process has already exited.
      }
    };
    const terminate = (): void => {
      send("SIGTERM");
      forceTimer = setTimeout(() => send("SIGKILL"), KILL_GRACE_MS);
    };
    const collect = (chunk: Buffer): void => {
      // Builds print their errors last, so the end is what must survive.
      output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT_CHARS);
    };
    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ output: output.trim(), exitCode, stopped, timedOut });
    };
    const onAbort = (): void => {
      stopped = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => {
      output += error.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));

    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort);
    }
  });
}
