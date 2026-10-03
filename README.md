<div align="center">

<img src="build/icon.png" width="112" alt="Scion, Graft's pixel sprout mascot" />

# Graft

**A desktop coding agent that works with your own model provider keys.**

Chat, code, search the web and run long tasks with the models you already pay for,
from Anthropic, OpenAI, Google, OpenRouter, local servers and 200+ other providers,
in a native desktop app for Windows, macOS and Linux.

[![CI](https://github.com/itzdexy/GraftCode/actions/workflows/ci.yml/badge.svg)](https://github.com/itzdexy/GraftCode/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/itzdexy/GraftCode?display_name=tag&sort=semver)](https://github.com/itzdexy/GraftCode/releases)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-3f6b35)
![Electron](https://img.shields.io/badge/Electron-44-47848f)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)

</div>

---

## Contents

- [Highlights](#highlights)
- [Install](#install)
- [First run](#first-run)
- [Features](#features)
- [Privacy and security](#privacy-and-security)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Build from source](#build-from-source)
- [Releases and updates](#releases-and-updates)
- [Architecture](#architecture)
- [Acknowledgements](#acknowledgements)

## Highlights

- **Your keys, your models.** Pick from a catalog of 200+ providers, or point Graft at any OpenAI-compatible endpoint or a local server such as Ollama or LM Studio.
- **A real agent for code.** Graft reads, edits, searches and runs commands in your project, with five permission modes, git worktrees per session, checkpoints and rewind.
- **Taproot.** A maximum-effort mode for long tasks. Graft investigates, plans with a task list it has to finish, verifies with your tests and builds, reviews its own diff, then reports with evidence.
- **Search the web for free** in chats and code sessions with Exa or DuckDuckGo, no key needed, or with Brave, Tavily, a SearXNG server or your model provider's own search. Results show as site chips, and answers cite their sources.
- **Private by design.** Graft can ask providers not to train on your data, and incognito chats never touch the disk. Keys stay in your system keyring.

## Install

Download the latest installer from the [Releases](https://github.com/itzdexy/GraftCode/releases) page:

| Platform | File |
| --- | --- |
| Windows (x64) | `Graft-Setup-<version>.exe` |
| macOS (Apple silicon) | `.dmg` or `.zip` |
| Linux (x64) | `.AppImage` or `.deb` |

The installers aren't code-signed yet. On Windows, SmartScreen may warn the first time: choose **More info → Run anyway**. On macOS, if the app won't open, choose **Open Anyway** in System Settings → Privacy & Security.

Installed copies check for new releases in the background. When an update has downloaded, Graft asks to restart, or installs it the next time you quit.

## First run

1. **Name and avatar.** Graft greets you by name. The name is never sent to a model in incognito chats.
2. **Pick a provider** from the searchable catalog and paste its API key. Graft checks the key before saving it.
3. **Choose a default model and effort,** then start a chat or open a folder for a code session.

You can add more providers at any time in **Settings → Providers**.

## Features

### Code sessions

- An agent loop with tools to read, write and edit files, search with ripgrep, run shell commands (including background commands), fetch pages, search the web, track tasks and delegate to read-only sub-agents.
- **Permission modes:** *Ask* (approve edits and commands), *Auto-edit* (edit project files freely), *Plan* (read and plan until you approve), *Auto* (approve low-risk actions) and *Bypass* (no prompts; only deny rules still block). Bypass has to be switched on in Settings first. Allow, ask and deny rules can be set per user and per project.
- **Git:** an optional worktree per session, hidden checkpoints before every turn, and rewind for files, the conversation or both. Diff and commit from the app, and open a pull request.
- **A transcript in the style of a terminal agent.** Each turn's work folds into one line, such as "Ran 3 commands, created a.ts, edited 2 files +75 −4 · 2m 50s". A card lists the files the turn changed, each opening to its diff. While a turn runs, a live status line shows elapsed time, context size and background tasks.
- **Panels:** an integrated terminal, a file browser with previews, changes and diffs, an embedded browser for local apps, and background tasks.
- **Computer use (Windows, opt-in):** with a model that can see images, the agent can take screenshots and use the mouse and keyboard. Each action asks first unless you allow it for the session, a banner shows while it is in control, and `Ctrl+Alt+Esc` stops it.
- **Project memory:** `GRAFT.md` instruction files, plus `AGENTS.md` and `CLAUDE.md` for compatibility with other tools. Also custom slash commands, skills, hooks and MCP servers.

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
