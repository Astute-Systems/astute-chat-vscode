/** Files and their parent folders, so the picker can offer both. */
export function withFolders(files: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      folders.add(`${parts.slice(0, depth).join("/")}/`);
    }
  }
  return [...folders, ...files];
}

function score(item: string, query: string): number {
  const path = item.toLowerCase();
  const name = path.replace(/\/$/, "").split("/").pop() ?? path;
  if (name === query) {
    return 0;
  }
  if (name.startsWith(query)) {
    return 1;
  }
  if (name.includes(query)) {
    return 2;
  }
  return path.includes(query) ? 3 : -1;
}

/** Best matches first: exact names, then name prefixes, then anywhere in the path. */
export function rankFiles(items: readonly string[], query: string, limit = 8): string[] {
  const wanted = query.toLowerCase();
  return items
    .map((item) => ({ item, rank: wanted ? score(item, wanted) : 1 }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.item.length - b.item.length || a.item.localeCompare(b.item))
    .slice(0, limit)
    .map((entry) => entry.item);
}

/** Finds an @ word ending at the cursor, as in "fix @src/ma". */
export function mentionAt(text: string, cursor: number): { start: number; query: string } | undefined {
  const match = text.slice(0, cursor).match(/(?:^|\s)@([\w./-]*)$/);
  return match ? { start: cursor - match[1].length - 1, query: match[1] } : undefined;
}
