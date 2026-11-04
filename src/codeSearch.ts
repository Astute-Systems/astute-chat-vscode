const CHUNK_LINES = 40;
const CHUNK_STEP = 30;
const K1 = 1.2;
const B = 0.75;
const STOP_WORDS = new Set("a an and are as at be but by can do does for from how i if in is it of on or our the this that to we what when where which why will with you".split(" "));

export interface CodeChunk {
  file: string;
  startLine: number;
  text: string;
}

export interface CodeMatch extends CodeChunk {
  score: number;
}

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.length > 5 && word.endsWith("ing")) {
    return word.slice(0, -3);
  }
  if (word.length > 4 && word.endsWith("ed")) {
    return word.slice(0, -2);
  }
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/** Splits text into search words, including the parts of names like runChat and max_retries. */
export function searchWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map(stem);
}

export function chunkFile(file: string, text: string): CodeChunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: CodeChunk[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_STEP) {
    const body = lines.slice(start, start + CHUNK_LINES).join("\n");
    if (body.trim()) {
      chunks.push({ file, startLine: start + 1, text: body });
    }
    if (start + CHUNK_LINES >= lines.length) {
      break;
    }
  }
  return chunks;
}

/** Ranks chunks with BM25, which favours rare words and doesn't reward long chunks. */
export function rankChunks(chunks: readonly CodeChunk[], query: string, limit = 5): CodeMatch[] {
  const terms = [...new Set(searchWords(query))];
  if (terms.length === 0 || chunks.length === 0) {
    return [];
  }
  const documents = chunks.map((chunk) => {
    const counts = new Map<string, number>();
    const words = [...searchWords(chunk.text), ...searchWords(chunk.file)];
    for (const word of words) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    return { chunk, counts, length: words.length };
  });
  const average = documents.reduce((total, document) => total + document.length, 0) / documents.length;
  const inverse = new Map(
    terms.map((term) => {
      const found = documents.filter((document) => document.counts.has(term)).length;
      return [term, Math.log(1 + (documents.length - found + 0.5) / (found + 0.5))];
    }),
  );

  const ranked = documents.map(({ chunk, counts, length }) => {
    let score = 0;
    for (const term of terms) {
      const count = counts.get(term) ?? 0;
      score += ((inverse.get(term) ?? 0) * count * (K1 + 1)) / (count + K1 * (1 - B + (B * length) / average) || 1);
    }
    return { ...chunk, score };
  });

  // Overlapping chunks of one file repeat each other, so each file appears once.
  const seen = new Set<string>();
  return ranked
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .filter((match) => !seen.has(match.file) && Boolean(seen.add(match.file)))
    .slice(0, limit);
}
