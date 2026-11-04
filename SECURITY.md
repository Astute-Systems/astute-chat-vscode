# Security

Astute Chat runs model output as tool calls on your machine, so we treat security problems seriously.

## Report a problem

Please don't open a public issue. Contact [Astute Systems](https://astutesys.com), and include:

- what you found, and what an attacker could do with it
- the steps to reproduce it
- your Astute Chat and VS Code versions

## What counts

Report anything that gets around one of these protections:

- a change or a command runs without approval, outside full **Auto**
- a read-only check changes something, or reads `.env` files, private keys or files outside the workspace
- a workspace starts an MCP server, turns on web tools, or redirects prompts to another server
- web tools reach a private address without `astuteChat.web.allowPrivateAddresses`
- model output or page text runs code in the chat panel

## What doesn't count

- Anything a command does after you approve it, or while full **Auto** is on. Commands can do anything your user account can.
- A model giving a wrong answer, or refusing to do something.
- What an MCP server you added does, because it runs as a program on your machine.

## Supported versions

We fix security problems in the latest release.
