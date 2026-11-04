import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

export const FONT_FILES = ["AstuteVectorMono-Regular.ttf", "AstuteVectorMono-Bold.ttf"];

/** Where this user's fonts live. Windows has no folder like this, because fonts must be registered. */
export function fontFolder(platform: NodeJS.Platform, home: string, dataHome?: string): string | undefined {
  if (platform === "darwin") {
    return path.join(home, "Library", "Fonts");
  }
  if (platform === "win32") {
    return undefined;
  }
  return path.join(dataHome || path.join(home, ".local", "share"), "fonts", "astute-vector-mono");
}

export async function fontsInstalled(folder: string): Promise<boolean> {
  const found = await Promise.all(FONT_FILES.map((file) => fs.access(path.join(folder, file)).then(() => true, () => false)));
  return found.every(Boolean);
}

export async function installFonts(source: string, folder: string): Promise<void> {
  await fs.mkdir(folder, { recursive: true });
  await Promise.all(FONT_FILES.map((file) => fs.copyFile(path.join(source, file), path.join(folder, file))));
}

/** New fonts can be found without this, but later. It's fine if the tool isn't there. */
export function refreshFontCache(platform: NodeJS.Platform, folder: string): Promise<void> {
  return new Promise((resolve) => {
    if (platform === "linux") {
      execFile("fc-cache", ["-f", folder], () => resolve());
    } else {
      resolve();
    }
  });
}
