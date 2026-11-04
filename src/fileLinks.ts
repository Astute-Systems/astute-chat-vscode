export interface FileReference {
  /** Where the reference sits in the text. */
  start: number;
  end: number;
  path: string;
  line?: number;
  column?: number;
}

const NAMES_WITHOUT_EXTENSION = "Makefile|Dockerfile|LICENSE|README|Jenkinsfile|Vagrantfile";
const REFERENCE = new RegExp(
  `(?<![\\w@/.:-])((?:\\.{0,2}/)?(?:[\\w@.+-]+/)*(?:[\\w+-][\\w.+-]*\\.[A-Za-z0-9]{1,10}|${NAMES_WITHOUT_EXTENSION}))(?:(?::(\\d+)(?::(\\d+))?(?:-\\d+)?)|#L(\\d+)(?:-L?\\d+)?)?(?![\\w/-])`,
  "g",
);

/** Finds text that looks like a file. Only the extension host can say if it exists. */
export function findFileReferences(text: string): FileReference[] {
  return Array.from(text.matchAll(REFERENCE), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
    path: match[1],
    line: match[2] || match[4] ? Number(match[2] ?? match[4]) : undefined,
    column: match[3] ? Number(match[3]) : undefined,
  }));
}
