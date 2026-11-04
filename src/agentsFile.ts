import * as fs from "fs/promises";
import * as path from "path";
import { isInside } from "./pathGuard";

const MAX_CHARS = 4000;

export interface AgentsFile {
  file: string;
  content: string;
  shortened: boolean;
}

/** Per the AGENTS.md convention, the file closest to the code being edited wins. */
export async function findAgentsFile(roots: readonly string[], activeFile?: string): Promise<AgentsFile | undefined> {
  const candidates: string[] = [];
  const root = activeFile ? roots.find((folder) => isInside(folder, activeFile)) : undefined;
  if (root && activeFile) {
    for (let folder = path.dirname(activeFile); isInside(root, folder); folder = path.dirname(folder)) {
      candidates.push(path.join(folder, "AGENTS.md"));
      if (folder === root) {
        break;
      }
    }
  }
  candidates.push(...roots.map((folder) => path.join(folder, "AGENTS.md")));

  for (const file of candidates) {
    try {
      const real = await fs.realpath(file);
      const realRoots = await Promise.all(roots.map((folder) => fs.realpath(folder)));
      if (!realRoots.some((folder) => isInside(folder, real))) {
        continue;
      }
      const text = (await fs.readFile(real, "utf8")).trim();
      if (text) {
        return { file, content: text.slice(0, MAX_CHARS), shortened: text.length > MAX_CHARS };
      }
    } catch {
      // No AGENTS.md here, so try the next folder up.
    }
  }
  return undefined;
}
