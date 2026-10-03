<div align="center">

<img src="build/icon.png" width="96" alt="Scion, Graft's pixel sprout" />

# Graft

**An open-source desktop coding agent and AI chat that runs on your own keys.**

Write and fix code, chat, research the web and run long tasks with the models you choose:
Anthropic, OpenAI, Google, OpenRouter, local models through Ollama or LM Studio, and 200+ other providers.
Connect it to Blender, Unity, Roblox Studio, GitHub and more. Windows, macOS and Linux.

**[Download the latest release](https://github.com/itzdexy/GraftCode/releases/latest)** · [What it does](#what-graft-does) · [Build from source](#build-from-source)

[![Release](https://img.shields.io/github/v/release/itzdexy/GraftCode?display_name=tag&sort=semver)](https://github.com/itzdexy/GraftCode/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/itzdexy/GraftCode/total)](https://github.com/itzdexy/GraftCode/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-3f6b35)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-3f6b35)

<img src="docs/screenshots/code-session.png" width="900" alt="A Graft code session: the agent read the code, fixed the bug, added a test and ran the tests" />

</div>

## What Graft does

- **Works in your project.** It reads the code, edits files, runs your tests and commands, and reports what it changed and how it checked. Every turn is checkpointed, so you can rewind the files, the conversation or both.
- **Runs on your keys and your models.** No subscription and no lock-in: pick any of 200+ providers, point it at an OpenAI-compatible endpoint, or use models running on your own computer.
- **Asks before it acts, until you say otherwise.** Five permission modes, from approving each edit to running on its own, with allow, ask and deny rules per project.
- **Finishes long tasks.** Turns run until the work is done. Taproot mode plans with a task list it has to complete, verifies with your tests and builds, and reviews its own diff before it reports.
- **Checks its own work.** Tell Graft your project's checks (type check, lint, tests) and it runs them after every change. When one fails, the agent reads the output and fixes the cause, up to two rounds.
- **Runs untrusted code in a sandbox.** Turn on the sandbox for a project and its commands run in a Docker or Podman container: only the project folder is shared, and your files, keys and credentials stay out of reach.
- **Tests what it builds.** The agent opens your dev server in the built-in browser, clicks through it like a person, reads the console and takes screenshots.
- **Works with the apps you build with.** One-click integrations for Blender, Roblox Studio, Unity, Godot, Figma, a Playwright browser, GitHub, Sentry, Linear, Notion and Context7, plus any MCP server.
- **Stays out of your way.** A command palette for everything, `!` to run a shell command from the message box, `↑` for earlier messages, and `/commit`, `/pr` and `/review` when you want them.
- **Chats too.** Web search with cited sources, files to download, a JavaScript sandbox for calculations, read aloud, and incognito chats that never touch the disk.
- **Keeps your data yours.** Keys are encrypted with your system keyring, and Graft asks providers not to train on your conversations.

## A look around

<table>
<tr>
<td width="50%"><img src="docs/screenshots/code-session-changes.png" alt="The changes panel showing the diff of a fix" /><br /><sub>Review each change as a diff, then commit or open a pull request.</sub></td>
<td width="50%"><img src="docs/screenshots/integrations.png" alt="The integrations gallery in Settings" /><br /><sub>Connect Blender, Unity, Roblox Studio, GitHub and more. (Roblox Studio and Figma need Windows or macOS.)</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/command-palette.png" alt="The command palette" /><br /><sub>Every action is a few keystrokes away in the command palette.</sub></td>
<td><img src="docs/screenshots/chat.png" alt="A chat explaining hash maps with a TypeScript example" /><br /><sub>Chats for everything else, with web search, files and a code sandbox.</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/agents.png" alt="Custom agents in Customize" /><br /><sub>Add specialists such as a reviewer or a test writer.</sub></td>
<td><img src="docs/screenshots/appearance.png" alt="Palettes and accent colours in Appearance settings" /><br /><sub>Six palettes, each light and dark, and seven accent colours.</sub></td>
</tr>
<tr>
<td><img src="docs/screenshots/checks.png" alt="A failed test check sent back to the agent, then passing after its fix" /><br /><sub>Your checks run after every change; a failure goes back to the agent to fix.</sub></td>
<td><img src="docs/screenshots/browser.png" alt="The agent testing a storefront in the Browser panel" /><br /><sub>The agent opens your dev server in the browser and clicks through it.</sub></td>
</tr>
</table>

## Install

| Platform | Download |
| --- | --- |
| Windows 10 and 11 (x64) | `Graft-Setup-<version>.exe` from the [latest release](https://github.com/itzdexy/GraftCode/releases/latest) |
| Linux (x64) | The `.AppImage` (mark it executable) or the `.deb` from the [latest release](https://github.com/itzdexy/GraftCode/releases/latest) |
| macOS (Apple silicon) | [Build it from source](#build-from-source) for now with `npm run dist:mac`; ready-made builds return when the release workflow runs again. |

The installers aren't code-signed yet. On Windows, SmartScreen may warn the first time: choose **More info → Run anyway**.

Graft keeps itself up to date: it downloads new versions in the background and asks to restart, or installs them the next time you quit.

## First run

1. **Name and avatar.** Graft greets you by name. The name is never sent to a model in incognito chats.
2. **Pick a provider** from the searchable catalog and paste its API key. Graft checks the key before saving it.
3. **Choose a default model and effort,** then start a chat or open a folder for a code session.

You can add more providers at any time in **Settings → Providers**, and connect other apps in **Settings → Integrations**.

## Features

### Code sessions

- An agent loop with tools to read, write and edit files, search with ripgrep, run shell commands (including background commands), fetch pages, search the web, track tasks and delegate to read-only sub-agents.
- **Permission modes:** *Ask* (approve edits and commands), *Auto-edit* (edit project files freely), *Plan* (read and plan until you approve), *Auto* (approve low-risk actions) and *Bypass* (no prompts; only deny rules still block). Bypass has to be switched on in Settings first. Allow, ask and deny rules can be set per user and per project.
- **Git:** an optional worktree per session, hidden checkpoints before every turn, and rewind for files, the conversation or both. Diff and commit from the app, and open a pull request.
- **A transcript in the style of a terminal agent.** Each turn's work folds into one line, such as "Ran 3 commands, created a.ts, edited 2 files +75 −4 · 2m 50s". A card lists the files the turn changed, each opening to its diff. While a turn runs, a live status line shows elapsed time, context size and background tasks.
- **Panels:** an integrated terminal, a file browser with previews, changes and diffs, a browser for local apps, and background tasks.
- **Checks after changes:** in **Customize → Checks**, list the commands that tell whether the project still works; Graft suggests them from `package.json` scripts (with your package manager), Cargo, Go and Python config. They run after any turn that changed files, show live in the transcript, and a failure goes back to the agent with its output and a reminder to fix the cause rather than weaken the check. Checks only run in projects you trust.
- **A browser for developers:** the Browser panel has a console with an error badge, find in page, zoom, phone and tablet widths, developer tools, reload without cache and clearing site data. Pick an element, take a screenshot or grab the console and it lands in your message. With no page open, it lists dev servers running on your computer and in the session's sandbox.
- **The agent tests in the browser:** the Browser tool opens a page, reads it as text plus numbered links, buttons and fields, clicks with real mouse events, types the way frameworks expect, waits for text, reads the console and takes screenshots. Opening a local dev server needs no approval in Auto-edit; other sites ask.
- **Computer use (Windows, opt-in):** with a model that can see images, the agent can take screenshots and use the mouse and keyboard. Each action asks first unless you allow it for the session, a banner shows while it is in control, and `Ctrl+Alt+Esc` stops it.
- **Project memory:** `GRAFT.md` instruction files, plus `AGENTS.md` and `CLAUDE.md` for compatibility with other tools. Also custom slash commands, skills, hooks and MCP servers.
- **Custom agents:** specialists such as a reviewer, a test writer or a debugger, written as Markdown in `~/.graft/agents` or a project's `.graft/agents` (or from templates in **Customize → Agents**). Graft hands them tasks with their own instructions and context. An agent's tool list can only narrow what the session allows.
- **Shell commands from the message box:** start a message with `!` to run it in the session's shell, for example `!npm test`. The output shows as a terminal card, and Graft sees it with your next message.
- **Commands for everyday work:** `/commit`, `/pr`, `/review`, `/security-review`, `/explain`, `/test` and `/init` send carefully written prompts; `/export`, `/system`, `/compact`, `/rewind` and `/new` act on the session. A command file with the same name replaces any of the prompt commands.
- **See what the model sees:** *View system prompt* (session menu or `/system`) shows the exact instructions and tools the next turn sends.

### Sandbox

A project's commands can run in a container instead of on your computer: the agent's shell commands, its background servers, the project's checks and your own `!` commands. Turn it on from the computer icon in a session's header, the command palette or **Settings → Sandbox**. It needs [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker on Linux) or [Podman](https://podman.io/); on Windows and macOS both run Linux containers in a small virtual machine.

| | |
| --- | --- |
| Shared with the container | The project folder only, at `/workspace` |
| Read-only inside it | `.git` and `.graft`, so nothing can plant a git hook, an fsmonitor command or a Graft hook that would run outside the sandbox |
| Out of reach | Your home folder, other projects, SSH keys, credentials, Graft's keys and your environment variables |
| Network | On by default so installs work, with common dev-server ports forwarded to `localhost`; one switch cuts it off entirely |
| Limits | Memory, CPUs and process count, no extra privileges, dangerous capabilities dropped |
| Dependencies | `node_modules` lives in a per-project volume, so installs in the sandbox never touch your own copy |

In Auto-edit and Auto, sandboxed commands run without asking, because they can only reach the project folder; commands that look dangerous still ask, and your deny rules still apply. The sandbox protects your computer, not the project itself: code in it can still change the project's files, which you review as diffs and can rewind.

### Integrations

Settings → Integrations adds well-known MCP servers in one step. Graft checks what each one needs, shows the setup steps from the project's own documentation, and keeps any token encrypted.

| Integration | What the agent can do | Needs |
| --- | --- | --- |
| Blender | Build and change scenes, materials and lighting, and run Python in Blender | [uv](https://docs.astral.sh/uv/) and the MCP for Blender add-on |
| Roblox Studio | Explore the place, write and run Luau, playtest | Roblox Studio with its MCP server turned on (Windows, macOS) |
| Unity | Manage scenes, GameObjects, scripts and assets; read the console | uv and the MCP for Unity package |
| Godot | Run and debug projects, read their output, create scenes and nodes | Node.js and Godot 4 |
| Figma | Read frames, components and design tokens | The Figma desktop app with its MCP server on (Windows, macOS) |
| Playwright browser | Drive a real browser: open, click, type, read and screenshot pages | Node.js |
| GitHub, Context7, Sentry, Linear, Notion | Work with issues, pull requests, docs and pages | A token or a sign-in |

Any other MCP server can be added by hand, for all projects or for one.

### Chats

- Conversations with attachments and images, and per-chat model and effort.
- **Web search and page reading** without prompts, with sources cited inline as site pills.
- **Files to download:** chats can create documents, data, code and pictures, shown as cards with Save, Open and Show in folder. Opening is limited to documents and pictures, so a click never runs a script.
- **Code in a sandbox:** chats run JavaScript in a hidden page with no network or file access to calculate, process data and make files.
- **They know the time:** each message carries when it was sent.
- **Read aloud** with pause, resume and stop, in a natural voice from OpenRouter's speech models or your computer's own voice (Settings → Voice).
- **Incognito chats** that are never saved. See [Privacy and security](#privacy-and-security).

### Models and providers

- A catalog generated from [models.dev](https://models.dev) with 200+ providers, plus Ollama and custom endpoints. Each model's context window, tool use, vision, effort levels and prices come from the catalog and the provider's own model list.
- **Effort levels per model,** from *Off* to *Max*, with *Taproot* on top for code sessions.
- Reasoning carried across tool calls for models that need it. Prompt caching for Claude models, both on Anthropic and through OpenRouter. Cost tracking that counts cached tokens at their own rates and uses the charged amount when the provider reports it.

### Personal and good-looking

- **Personalization:** tell Graft what it should know about you and how to respond, and choose a response style: balanced, concise, explanatory or learning. Every chat and code session uses it; incognito chats never do.
- **Command palette** (`Ctrl+Shift+P`, or `>` in search): start sessions, switch palettes and themes, open any settings page, export, compact, rewind and more, with fuzzy search and your recent commands first.
- **Appearance:** six palettes (Graft, Midnight, Slate, Grove, Dune and High contrast), each in light and dark, seven accent colours, and calm motion that respects *Reduce motion*.

### Web search engines

| Engine | Needs |
| --- | --- |
| Exa or DuckDuckGo | Nothing: free, with no key or account. Each stands in for the other when it's busy. |
| Brave Search or Tavily | An API key from that service |
| SearXNG | The address of your own instance |
| Anthropic, OpenAI, Google Gemini or OpenRouter | That provider's key in Graft. Billed by the provider; the search runs on its cheapest suitable model, and Claude models on Anthropic search directly. |

*Automatic* uses Brave, Tavily or SearXNG once you set one up, and the free engines otherwise. A provider's paid search runs only when you pick it.

## Privacy and security

- **API keys** are encrypted with the operating system's keyring (Electron `safeStorage`). If no keyring is available, Graft refuses to store keys unless you explicitly opt in. Keys never reach the user interface after you enter them, and they never appear in logs.
- **"Ask providers not to train on my data"** is on by default. OpenRouter then routes only to providers that don't store or train on prompts, and OpenAI requests ask not to store responses. Settings → Privacy shows, for each provider, what Graft can and can't enforce.
- **Incognito chats**
  - live only in memory and are gone when you delete them or quit;
  - never generate a title through a model;
  - leave your name out of the prompt and their text out of system notifications;
  - on OpenRouter, use only providers that keep no data at all.
  
  You can also restrict them to models running on your own computer.
- **The renderer is sandboxed:** `contextIsolation` is on, `nodeIntegration` is off, a strict content security policy applies, and a typed preload bridge is the only way in. Filesystem, shell, git, network and keys all live in the main process.
- File contents, tool output, web pages and MCP output are treated as untrusted and can never change permission rules.
- Destructive commands, such as force pushes, hard resets and recursive deletes, always ask first. The one exception is Bypass mode, which you have to switch on yourself and which can keep these checks ("Keep safety checks in Bypass").
- **The sandbox** (optional, per project) runs commands in a container that sees only the project folder, with `.git` and `.graft` read-only. See [Sandbox](#sandbox).
- **The Browser panel** runs pages in their own in-memory session with no preload script, every permission denied, downloads blocked and only `http` and `https` allowed. Graft's own page scripts run in an isolated world the page can't see.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| New session | `Ctrl+N` |
| Search | `Ctrl+K` |
| Toggle sidebar | `Ctrl+B` |
| Toggle terminal | ``Ctrl+` `` |
| Toggle changes | `Ctrl+Shift+D` |
| Toggle files | `Ctrl+Shift+F` |
| Focus the message box | `Ctrl+L` |
| Stop the agent | `Esc` |
| Cycle permission mode | `Shift+Tab` |
| Settings | `Ctrl+,` |
| Command palette | `Ctrl+Shift+P`, or `>` in search |

In the message box, `/` lists commands, `@` mentions a file, `!` runs a shell command in a code session, and `↑`/`↓` bring back messages you sent.

On macOS, `Ctrl` is `Cmd`. Every shortcut can be changed in **Settings → Shortcuts**.

## Build from source

You need Node.js 22 or later, and Git.

```bash
npm ci
npm run dev        # run Graft with hot reload
```

| Script | What it does |
| --- | --- |
| `npm run build` | Builds the main process, preload and renderer into `out/` |
| `npm run typecheck` | Strict TypeScript checks for every project |
| `npm run lint` | ESLint with zero warnings allowed |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | End-to-end tests that drive the built app (Playwright) |
| `npm run dist:win` / `dist:mac` / `dist:linux` | Builds installers with electron-builder |
| `npm run dist:linux:docker` | Builds and smoke-tests the Linux installers in a Docker container, from any OS |
| `npm run icons` | Regenerates the app and tray icons from the mascot sprite |
| `node scripts/generate-palettes.mjs` | Regenerates the colour palettes and accents from the neutral tokens |
| `npm run catalog` | Refreshes the provider and model catalog from models.dev |

## Releases and updates

1. Bump `version` in `package.json` and add the release notes to `src/renderer/src/features/home/releaseNotes.json`. The app shows them under "What's new", and the release on GitHub uses the same text.
2. Commit, tag and push:
   ```bash
   git tag v0.3.0
   git push origin main --tags
   ```
3. The **Release** workflow builds the installers on Windows, macOS and Linux, starts each packaged app for a smoke test, and attaches them to a draft release. It publishes the release only when every platform passed. Installed copies then pick up the update automatically.

Running the Release workflow by hand (**Actions → Release → Run workflow**) is a dry run: the same builds and checks, with the installers kept as workflow artifacts.

Without GitHub Actions, build on your own machine and upload the files `electron-builder` wrote to `dist/` (the installer, its `.blockmap` and `latest.yml`; `latest-linux.yml` or `latest-mac.yml` on the other platforms):

```bash
npm run dist:win
node scripts/release-notes.mjs 0.3.0 > notes.md
gh release create v0.3.0 dist/Graft-Setup-0.3.0.exe dist/Graft-Setup-0.3.0.exe.blockmap dist/latest.yml --title "Graft 0.3.0" --notes-file notes.md
```

With Docker, `npm run dist:linux:docker` builds the Linux installers in a container on any OS and writes them to `dist/linux/`; add them with `gh release upload v0.3.0 dist/linux/*`. macOS installers have to be built on a Mac.

> Installed apps read releases without signing in, so the releases must be public for updates to reach users. To ship from your own server instead, build with `GRAFT_UPDATE_URL` set to an HTTPS folder that holds `latest.yml` and the installers.

## Architecture

```
src/
  main/        Electron main process: agent loop, tools, permissions, providers,
               storage (SQLite), git, terminals, MCP, search, updates
  preload/     the typed bridge, the renderer's only way to reach the main process
  renderer/    React UI (Zustand stores, Tailwind tokens, Radix primitives)
  shared/      schemas and IPC contracts (Zod), shared by both sides
resources/     the provider catalog and tray icons shipped with the app
scripts/       the icon generator, the catalog builder, measurement tools
tests/         unit tests (Vitest) and end-to-end tests (Playwright)
```

- Every IPC channel is declared once in `src/shared/ipc/contracts.ts`, and its input and output are validated with Zod on both sides.
- Provider adapters cover Anthropic, OpenAI-style chat completions (OpenAI, OpenRouter and every compatible provider), Gemini and Ollama, all behind one streaming interface.
- Each session runs its own agent loop, so sessions work concurrently. Sessions and settings are stored in SQLite with versioned migrations.

## Acknowledgements

- Model and provider metadata comes from [models.dev](https://models.dev) (MIT License).
- Graft is built with [Electron](https://www.electronjs.org/), [React](https://react.dev/), [Vite](https://vitejs.dev/), [Zod](https://zod.dev/), [Radix UI](https://www.radix-ui.com/) and [ripgrep](https://github.com/BurntSushi/ripgrep).

Graft is an independent project. It is not affiliated with or endorsed by any model provider.
