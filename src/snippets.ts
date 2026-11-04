const SHELL_LANGUAGES = new Set(["", "sh", "bash", "zsh", "fish", "shell", "shellsession", "console", "terminal", "powershell", "ps1", "pwsh", "bat", "cmd"]);

/** Reads the language from a markdown code element's class, such as "language-bash". */
export function snippetLanguage(className: string): string {
  return className.match(/(?:^|\s)language-([\w+#-]+)/)?.[1]?.toLowerCase() ?? "";
}

/** Only shell snippets can run. Sending C or Python to a shell would just fail. */
export function canRunInTerminal(language: string): boolean {
  return SHELL_LANGUAGES.has(language);
}

/** Removes the "$ " prompts that models copy into examples, and the trailing newline. */
export function toTerminalCommand(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const commands = lines.filter((line) => line.trim());
  const hasPrompts = commands.length > 0 && commands.every((line) => /^\s*\$ /.test(line));
  return (hasPrompts ? lines.map((line) => line.replace(/^\s*\$ /, "")) : lines).join("\n");
}
