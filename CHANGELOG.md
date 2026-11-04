# Changelog

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

- Optional web research, with search through your own SearXNG server
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

### Ollama

- Shows which models support tools, vision and thinking
- Any local or network server by IP address and port
- Automatic CPU thread count for local servers on large CPUs
- Works with no internet connection
