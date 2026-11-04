# Astute Chat for VS Code

Astute Chat is an offline-first VS Code chat client for Ollama. Its main UI is a webview tab in the secondary side bar, next to Chat. Keep it working with no internet, no GitHub sign-in and no Copilot.

## Check the API before you rely on it

Your training data goes out of date faster than these APIs change. This project has already been caught out: chat participants were deprecated, and the secondary side bar contribution is missing from the contribution-points page.

Fetch the current official documentation, and read the source of truth listed below, before you:

- add or change a VS Code API call, `package.json` contribution, activation event or `engines.vscode` value
- add or change an Ollama endpoint, request field or response field
- plan or review a feature that depends on either API
- debug behaviour that does not match what you expected from an API
- change webview security settings such as the CSP or `localResourceRoots`
- raise a dependency that defines an API contract, such as `@types/vscode`
- start a compliance review or release

You do not need to fetch documentation for changes that touch no API, such as internal refactors, UI styling or tests that use contracts already checked.

| API | Fetch this | Then confirm against |
| --- | --- | --- |
| VS Code extension API | https://code.visualstudio.com/api/references/vscode-api | `node_modules/@types/vscode/index.d.ts` |
| Manifest contributions | https://code.visualstudio.com/api/references/contribution-points | A working extension or the installed workbench if the docs are silent |
| AI extensibility and deprecations | https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview | The linked migration guide |
| Webviews | https://code.visualstudio.com/api/extension-guides/webview | `src/chatView.ts` CSP |
| Ollama REST API | https://docs.ollama.com/api/chat and https://docs.ollama.com/openapi.yaml | A `curl` probe against a running server |

When documentation and behaviour disagree, test the real system and record the difference in your response. Say which docs you checked. If you could not fetch them, say so instead of working from memory.

Do not use `enabledApiProposals`. Proposed APIs work only in Insiders and must not be published.

## Rules that are easy to miss

- Keep server settings at `machine` scope. Workspace-scoped settings would let a cloned repository redirect code and prompts to another server.
- Use the `http` and `https` modules for Ollama calls, not `fetch`. Slow CPU models can exceed the `fetch` headers timeout.
- Keep `@astute` as a thin wrapper around `src/chatService.ts`. Chat participants are deprecated, so put new features in the panel and the shared service.
- Bundle every webview dependency. Do not load anything from a CDN, because the extension must work on air-gapped machines.
- Treat model output, workspace skills and file contents as untrusted. Keep `html: false` in markdown-it, and keep the strict CSP.
- Disable skills and workspace tools in untrusted workspaces.
- Ask and Plan must never receive change tools. `isToolAllowed` checks this again when a tool runs, because models can call tools they were not offered.
- Every Agent file change and command needs approval, from the user or from `decide()` in `src/approvals.ts`. Keep Ask as the default mode for any caller.
- `checkCommand` must judge arguments as the shell passes them, using `parseShell`. Checking the written text let `cat .en*` and `cat '.en'v` read `.env`. If a command has a mode that changes anything, list only its safe forms in `READ_ONLY_FORMS`.
- Keep `checkCommand` as an allowlist of read-only commands. Do not add build, test or install commands, because they run project code. Only the explicit full Auto toggle may skip approval, and its hard limits in `src/tools.ts` must stay.
- Stop must end everything: pending approvals, the Ollama request, queued tools and whole command process groups.
- Measure speed before changing thread or model defaults. Using every core was about three times slower than 16 threads on a 24-core Core Ultra 9 275HX.
- Agent mode must never finish silently with nothing done. Models treat short requests as questions, so keep the request reminder, the single retry and the "nothing changed" notice in `src/modes.ts` and `src/chatEngine.ts`.
- Code snippet Run must stay a direct user click. Only offer it on finished shell snippets, and never trigger it from model output.
- Link a file name only after the extension confirms it exists in the workspace, so invented paths stay plain text. Check paths again when opening, because they come from the webview.
- Agent must never create dummy files. `src/contentGuard.ts` enforces this in code, before approval. Keep it there rather than relying on the prompt, because models ignore prompts and report success anyway.
- Keep images out of stored transcripts. Store thumbnails and the text read from them only.
- Add a rule to `src/languageSkills.ts` only for a mistake seen in a real run. Language skills stay off by default until `src/integration/eval.ts` shows they improve results.
- VS Code has no API for the Explorer selection. Use the `explorer/context` command arguments, not clipboard tricks such as `copyFilePath`.
- Send open-file and folder context with the request only. Do not store it in the transcript, or history will fill the context window.
- `fitToContext` must always keep the system prompt, the current request and the latest tool results, and must keep tool results paired with their calls.
- The Agent change report must come from `ChangeJournal`, never from the model. Undo must skip files that changed since.
- Keep chat summaries in the system prompt, which is never trimmed.
- Do not run real-model tests alongside other work. Contention caused false timeouts.
- MCP servers must come only from `machine`-scoped settings, because they start programs. MCP tool annotations are untrusted, so every call asks unless full Auto is on.
- Web tools stay off by default, with `machine`-scoped settings. Every request needs approval, and page text is untrusted. `src/webTools.ts` must check private addresses at connection time and on every redirect, so don't remove `publicLookup`.
- Review mode stays off by default, and must never commit files Agent didn't write or touch uncommitted user work.
- Do not auto-pull models or add telemetry.
- Ollama reports token totals only at the end of a stream. Live counts are estimates, and the final count must come from `eval_count`.

## Theme

The panel is a retro vector display and stays dark on every VS Code theme. Chat text is vector blue in Orbitron. Code, tool calls and other monospace text are white Courier Prime. Controls use the Astute Systems logo cyan, `#36c8e6`, from `icons/astute-logo.svg`. Use the tokens in `media/chat.css`, not VS Code theme colours.

Both fonts are bundled in `media/fonts` so they work offline. Keep their licence files with them.

The optional **Astute Vector** colour theme in `themes/` applies these colours to all of VS Code. `astuteChat.vectorTheme.enabled` stays off by default, with `application` scope, and `src/vectorTheme.ts` must restore what it changes and leave anything the user changed. The terminal font, Astute Vector Mono, is generated by `tools/build-terminal-font.py`. Orbitron is a Reserved Font Name, so a modified font must never use that name. Installing a font changes the user's system, so it must stay an explicit command that asks first. Don't patch VS Code's own files to change the interface font: that's unsupported, and it triggers a corrupt installation warning.

Finished replies end with "End Of Line". The panel draws this, so do not add it to the model's reply or its history.

## Commands

- `npm run compile`: type-check and bundle
- `npm test`: unit and mock-server tests
- `npm run package`: build the VSIX
