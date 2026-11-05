# Changelog

## Unreleased

- Models such as `qwen2.5-coder` that write tool calls as plain text now work, instead of showing the JSON as the answer

## 0.19.0

- Agent checks that its work really finished: a failing task gets 10 more tool rounds, failed edits count as failures, and a new error no longer uses up the three fix attempts
- When Agent can't finish, it must say what still fails and quote the error, rather than promising to try again
- Agent now keeps the end of long command output, where build errors appear
- New Guide: type while a reply runs and the model reads it at its next step. Guidance can't approve anything
- The default context window is now 32768 tokens, up from 8192, because thinking models filled the old one within a turn or two

## 0.18.0

- Astute Chat is now Astute Code, with a new logo. Your settings, saved chats and installed extension carry over unchanged
- The context figure no longer climbs to 100% during long Agent runs by counting earlier replies twice
- Plans now follow a fixed template and are saved as files, with a new **Edit plan** button
- Plans are checked in code, and sent back once if they skipped the research, lack a section, or name files wrongly
- Plan can ask up to three questions, and Implement warns about open questions and files that changed since the plan was written
- Agent keeps the plan you approved in view while it works, so a long chat can't summarise it away
- Agent now runs a plan one step at a time, and pauses with **Continue** if a step fails, is denied, runs out of tool rounds or ends in a question
- **Implement in Agent mode** now carries out the plan you selected, not the newest one

## 0.17.0

- New **Chats** section in the Astute tab lists your chats in a native view
- New Chat during a reply now saves the reply instead of discarding it
- Each chat now keeps its summary in an editable `context.txt`, with a record of the files and commands it used
- New **Update Chat Context** command summarises a chat on request
- New **Open Chat Context** button and command, and a live context figure next to Send
- Long chats are summarised before messages are dropped, using the answering model and its real context window
- The summary has a size limit, and the token count now includes tool calls and learns how each model counts tokens

## 0.16.1

- Show Logs now lists how each tool ended and what the change report contained
- Settings say that automatic choices use the smallest local model

## 0.16.0

First Marketplace release.

### Chat

- Chat tab in the secondary side bar, with a retro vector display
- Optional Astute Vector look for all of VS Code, with a colour theme, a monospaced vector font for the terminal and matching code fonts
- Streaming replies with a live token count and speed
- Collapsible reasoning from models that support thinking
- Stop button, also on Esc, which ends replies, approvals and running commands
- Copy and Run buttons on code snippets, and small scrolling code windows
- Links that open workspace files at the right line

### Agent

- Optional web research, with search through DuckDuckGo or your own SearXNG server
- Review mode, which keeps Agent's work on a branch to merge or discard
- MCP tools from local servers in your user settings, with the 20-tool limit shared evenly between servers and failed servers restarted
- A checklist for longer tasks
- A setting for the Agent model, with an automatic choice if the selected model can't use tools
- Ask, Plan and Agent modes
- Read, search, edit and command tools
- Read-only git and system checks in every mode, with no approval needed
- Approval cards with Ask first, Auto-edit and Safe auto levels, plus a full Auto toggle
- Checks that refuse dummy files, build outputs and placeholder code
- Failed commands are sent back to be fixed, up to three times
- Each edit is checked for new errors, a tool runs your project's tests, and models can find definitions and references
- A diff view for proposed changes, a report of what really changed, and Undo

### Context

- The open file, selected code, and files or folders you add
- `@` picker for workspace files and folders
- The Problems panel and your recent terminal output
- Long chats are summarised instead of dropped
- Saved chat history
- Code search from a plain description
- Your operating system and shell, so answers suit your machine
- The workspace root, Git repository root and branch
- Images and screenshots, with a vision model to read them for other models
- Workspace skills and `AGENTS.md`
- A short project summary with entry points and build commands, read from your manifests

### Ollama

- Shows which models support tools, vision and thinking
- Any local or network server by IP address and port
- Automatic CPU thread count for local servers on large CPUs
- Works with no internet connection
- Cloud models are marked, and are never chosen automatically
