import * as path from "path";

/** Files that only a compiler, linker or archiver can produce. */
const BUILD_OUTPUT = /\.(a|o|obj|so|dylib|dll|lib|exe|elf|bin|hex|class|jar|pyc|wasm|ko)$/i;
/** Binary formats that text tools cannot write. */
const BINARY_FILE = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tar|tgz|7z|woff2?|ttf)$/i;
/** Files that are correct when empty. */
const MAY_BE_EMPTY = /(^|\/)(__init__\.py|py\.typed|\.gitkeep|\.nojekyll)$/;

const C_STYLE = /\.(c|cc|cpp|cxx|h|hpp|cs|java|js|jsx|ts|tsx|go|rs|swift|kt|scala|php)$/i;
const HASH_STYLE = /\.(py|rb|sh|bash|pl|r)$/i;
/** Prose and data files, where words like "sample" are normal. */
const DOCUMENT = /\.(md|markdown|txt|rst|adoc|json|ya?ml|toml|ini|cfg|xml|svg|html?|csv|log)$/i;
const PLACEHOLDER = /\b(placeholder|dummy|sample (library|code|file|function|program|project)|example (library|code|file|function)|this is an? (sample|example|test|demo)|stub(bed)?|lorem ipsum|your code( goes)? here|implement(ation)? (this|me|here|goes here)|function implementation|todo:? implement|not (yet )?implemented|add (your|the) (code|logic|implementation)|goes here|fill (this )?in)\b/i;

function isCommentLine(line: string, file: string): boolean {
  const text = line.trim();
  if (HASH_STYLE.test(file)) {
    return text.startsWith("#");
  }
  if (C_STYLE.test(file)) {
    return text.startsWith("//") || text.startsWith("/*") || text.startsWith("*");
  }
  // An unknown type, such as a file called "lib": accept either comment style.
  return text.startsWith("//") || text.startsWith("/*") || text.startsWith("#");
}

function hasPlaceholderComment(text: string, file: string): boolean {
  return text.split("\n").some((line) => isCommentLine(line, file) && PLACEHOLDER.test(line));
}

/** Explains why a file must not be written, or returns undefined if it is fine. */
export function checkFileContent(file: string, content: string): string | undefined {
  const name = file.replace(/\\/g, "/");
  if (BUILD_OUTPUT.test(name)) {
    return `${path.basename(name)} is a build output. Write the source files, then build it with run_command.`;
  }
  if (BINARY_FILE.test(name)) {
    return `${path.basename(name)} is a binary file, which write_file can't create.`;
  }
  if (!content.trim()) {
    return MAY_BE_EMPTY.test(name) ? undefined : `The content for ${path.basename(name)} is empty. Write the real file content.`;
  }
  if (DOCUMENT.test(name)) {
    return undefined;
  }
  if (hasPlaceholderComment(content, name)) {
    return `${path.basename(name)} contains a placeholder or sample comment. Write the real implementation.`;
  }
  if (!C_STYLE.test(name) && !HASH_STYLE.test(name)) {
    return undefined;
  }
  const lines = content.split("\n").filter((line) => line.trim());
  if (lines.every((line) => isCommentLine(line, name) || /^\s*\*\/\s*$/.test(line))) {
    return `${path.basename(name)} contains only comments. Write the real implementation.`;
  }
  return undefined;
}

/** An edit may remove text, so only its new text is checked for placeholders. */
export function checkEditContent(file: string, newText: string): string | undefined {
  const name = file.replace(/\\/g, "/");
  if (BUILD_OUTPUT.test(name) || BINARY_FILE.test(name)) {
    return checkFileContent(name, "x");
  }
  return !DOCUMENT.test(name) && hasPlaceholderComment(newText, name) ? `The new text for ${path.basename(name)} contains a placeholder comment. Write the real implementation.` : undefined;
}

export const IMAGE_FILE = /\.(png|jpe?g)$/i;
export const BUILD_OUTPUT_GLOB = "**/*.{a,o,obj,so,dylib,dll,lib,exe,elf,bin,hex,class,jar,wasm,ko}";
