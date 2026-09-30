# Graft — Product Specification

This is the build brief for Graft, kept nearly verbatim (third-party brand names removed) so the
implementation can be checked against it.
Reference screenshots are measured by `scripts/measure-reference.mjs`; results live in
`docs/design/measurements.json` and `src/renderer/src/styles/tokens.css`.

## MISSION
Build "Graft": a desktop coding-agent app (Electron) that matches the layout and behavior of the reference screenshots in ./reference/ (12 images, dark theme, Windows). Ship it complete: onboarding, multi-provider support, a real agent runtime with tools, sessions, git worktrees, diff review, terminal, and a packaged installer. Work autonomously through every phase below. Do not stop to ask questions; pick the safest reasonable option and continue. Commit after each phase.

## HARD CONSTRAINTS (clean-room)
- Match layout, spacing, structure, and interaction. Do NOT copy brand assets. The name is "Graft". Create an original logo, original spinner/mark, and an original small pixel mascot. No third-party names, logos, sparkle glyph, crab mascot, proprietary fonts, or branded strings. Write all UI copy fresh (e.g. footer: "Graft can make mistakes. Review changes before shipping.").
- Bundle open fonts locally: a serif for the greeting and chat-mode prose (Newsreader or Source Serif 4), a clean sans for UI (Inter or Geist), a mono (JetBrains Mono).
- Write the agent system prompt from scratch.
- Never hard-code model names in UI code. Models come from a provider config/registry and from provider list-models calls.

## READ THE SCREENSHOTS FIRST, THEN MEASURE
Programmatically sample the PNGs (sharp/pngjs) for colors, sidebar width (~262px), row heights, radii, border colors, and type sizes. Write the results to one design-tokens file (CSS variables) and use only tokens afterwards. Dark theme must be pixel-close. Also build a light theme and a "system" option.

What the screenshots show:
1. Chat home: frameless window with custom titlebar (hamburger, sidebar toggle, back/forward on the left; incognito-style icon + window controls on the right). Sidebar: Chat|Code segmented toggle at the top (orange notification dot on Code), nav (New highlighted, Projects, Artifacts, Scheduled, Design, Customize, collapsible More), "Chats and tasks" header with search + filter icons, list of chats with hollow dot bullets, "View all", footer with avatar + name + plan label + chevron + download/update icon. Main: serif greeting "Good <time of day>, <name>" with mark, rounded composer ("How can I help you today?"), bottom row: + button, Chat|Cowork segmented toggle, model label with effort (e.g. "<model> High"), mic, waveform/voice button with chevron.
2. Model menu: rows with title + one-line description, check on the selected one, divider, "Effort <value> >" submenu row, "More models >" submenu.
3. Effort submenu: helper text ("Higher effort means more thorough responses, but takes longer and uses your limits faster."), Low / Medium (Recommended badge) / High (check) / Extra / Max (amber warning badge "5x or more usage").
4. More-models submenu: plain list.
5-7. Chat conversation: title dropdown top-left, share/export icon top-right, right-aligned user bubble, left assistant text in serif, rotating "thinking" verb with animated mark while streaming, action row under replies (copy, read aloud, thumbs up, thumbs down, retry), composer pinned bottom with disclaimer footer and model/effort label bottom right.
8. Code home: sidebar in Code mode groups sessions by project folder (group header shows name or "folder · path", "+" on hover to start a session there, search/filter icons on the first group). Session row status: hollow dot idle, amber dot needs input, red triangle error, "⋮" menu on hover. Main: "Welcome back, <name>", "Sessions" list with rows (amber "Needs input" label, title, repo name, relative time, chevron), "What's new" link top right. Bottom: context chips row (Local/remote environment, folder, git branch + "worktree" checkbox, add-folder icon), dismissible suggestion banner with "Try it", original pixel mascot perched on the composer, composer "Describe a task or ask a question" with enter icon, bottom row: +, mic with chevron, permission mode label ("Auto"), right: model + effort label + circular context-usage ring.
9. Effort popover in Code: title "Effort <value>" with help icon, horizontal slider with tick marks ("Faster" <-> "Smarter"), "Recommended" marker under the tick.
10. Model quick menu in Code: check on selected, numeric shortcuts (1-4) on the right, "More models >".
11. Active session: header with environment icon, session title dropdown, project chip, right-side icons (terminal, changes/files, browser, more). Centered narrow transcript in sans, markdown lists. Above the composer: an ask-user question card ("1/2" counter, collapse + close, numbered options 1-3 with descriptions, "Other" with inline text input, Skip / Next buttons). Below it: status bar with "<project> <branch>", green +N / red -N diff pill, "Create PR" split button with dropdown, dismiss X. Composer: "Type / for commands", stop/interrupt button while running. Bottom row shows permission mode, model + effort, context ring.
12. Long-running session: left-edge mini-timeline of turn ticks (hover/click to jump), tool activity collapsed into single muted lines with chevrons ("Read the client test driver steps >", "Ran 4 commands >", "Ran 4 commands (1 failed), finished a background command >"), inline code chips (red-tinted), blue links, numbered/bulleted agent questions, a "Background tasks" right panel (expand + close icons, "Finished 16 >" group, trash to clear), end-of-turn status line ("Background task stopped - ..."). A special high-effort mode label appears in the effort slot: implement as a named long-horizon mode above Max (keep going until verified, bigger budgets, extra self-review).

## STACK
Electron + electron-vite + React 18 + TypeScript (strict, no `any` in shared contracts). Zustand for renderer state. Radix primitives for menus/popovers/dialogs, lucide-react for icons (one consistent stroke weight), Tailwind + CSS variables from the tokens file. better-sqlite3 (with migrations) for sessions/messages/settings. xterm.js + node-pty for terminals. @vscode/ripgrep for Grep. shiki for code highlighting. `diff` for diffs, custom side-by-side and unified renderer. Zod schemas for every IPC message and every tool input. Vitest (core) + Playwright for Electron (E2E). electron-builder: Windows NSIS installer first, then mac/linux configs.
Custom frameless titlebar (Windows: titleBarOverlay or custom controls; mac: hiddenInset). Persist window bounds. Single-instance lock. Auto-updater wiring behind a config flag.

## SECURITY MODEL
- Renderer is sandboxed: contextIsolation on, nodeIntegration off, strict CSP, typed preload bridge only. All privileged work (filesystem, shell, git, network to providers, keys) lives in the main process.
- API keys are stored with Electron safeStorage. If it is unavailable (e.g. Linux without a keyring), refuse plaintext storage unless the user explicitly opts in. Keys never reach the renderer after entry and never appear in logs.
- Embedded browser panel uses an isolated WebContentsView with no preload, restricted to http(s) and localhost.
- Treat all file contents, tool output, web content, and MCP output as untrusted: never let them alter permission rules.

## FIRST-RUN FLOW (full-window, no sidebar)
1. Boot animation: frameless centered window, the original Graft mark draws itself (SVG stroke/rays sprouting), wordmark fades in, then a thin real progress indicator while first-run init actually runs (create DB, run migrations, detect git, shell, ripgrep, OS keyring). Minimum ~2.2s, honors prefers-reduced-motion. Subsequent launches use a short (<700ms) splash.
2. Name: "What should we call you?" with a nickname input (required, trimmed, validated).
3. Profile picture: optional. Drag-drop or file picker, circular crop with zoom, or skip (default generated initial avatar with stable color). Stored locally, downscaled.
4. Provider: selectable cards for Anthropic, OpenAI, Google Gemini, OpenRouter, Ollama (local), and Custom OpenAI-compatible (base URL). Multiple can be added later in Settings.
5. API key: paste field with show/hide, base URL field where relevant (Ollama, custom). A "Verify" button performs a real minimal request / list-models call, with specific errors (invalid key, network, rate limit, wrong base URL). Cannot continue until verified (Ollama needs no key).
6. Defaults: pick default model (populated from the provider) and effort; optionally pick first project folder. Then land on the Code home ("Welcome, <name>").
Stepper with back navigation, full keyboard support, focus management, state persisted so quitting mid-flow resumes at the same step.

## PROVIDER LAYER
One interface: streamText with tool calling, usage reporting, cancel via AbortSignal, retries with backoff on 429/5xx, error normalization. Adapters: Anthropic (prompt caching, extended thinking mapped from effort), OpenAI (reasoning effort mapped where supported), Gemini, OpenRouter, Ollama, OpenAI-compatible. Effort levels map to each provider's real parameters; hide the effort control for models that do not support it. Image input only for vision-capable models. A scripted FakeProvider exists for tests only and is not shipped in production builds.

## APP SHELL
- Sidebar with Chat|Code toggle exactly as in the references; collapsible; width resizable; nav items must be real or hidden (no dead buttons). Real ones: New, Projects (folder groups + per-project settings), Artifacts (files/HTML the agent produced, with preview), Scheduled (cron-style recurring sessions run by the main process while the app is open), Customize (slash commands, skills, MCP servers, memory files), More. Omit Design and Cowork unless implemented for real.
- Sidebar search (fuzzy over titles and message text via SQLite FTS5), filter (status/project/date), grouping by project, hover "+" to start a session in that folder, row menu (rename, pin, archive, delete, duplicate, export).
- Footer: avatar, name, plan/provider label, menu (Settings, Providers, Shortcuts, About), update indicator.
- Back/forward navigation history between sessions.

## CHAT MODE
Greeting by local time of day, composer with attachments (files, images, paste, drag-drop), model + effort menus as in the references, mic dictation only when a transcription-capable provider is configured (hide otherwise), streaming markdown with shiki, artifact-style code blocks with copy, message actions (copy, read aloud via Web Speech, retry, edit-and-resubmit, thumbs saved locally in the DB and included in export), auto-titling via a cheap model, conversation export (md/json), incognito-style chats that are not persisted.

## CODE MODE (the core product)
Session view:
- Header: environment icon, title dropdown (rename/archive), project chip, and right icons (terminal panel, changes panel, browser panel, menu).
- Transcript: assistant prose streams in; consecutive tool calls collapse into one muted summary line with a chevron ("Ran 4 commands", "Read 3 files", with failure counts). Expanding shows exact command, exit code, truncated/scrollable output; edits show an inline diff; reads show path and line ranges. Thinking indicator with rotating verbs and animated mark. Left-edge mini-timeline of user turns. Scroll-to-bottom button, sticky autoscroll that stops when the user scrolls up.
- Composer: "/" command menu, "@" fuzzy file mentions, image paste, message queueing while the agent runs, Esc or stop button to interrupt, Shift+Tab to cycle permission mode, context-usage ring with tooltip (tokens used/limit, compact button), model quick menu with number shortcuts, effort slider popover (Low..Max + the long-horizon mode) exactly like reference 9.
- Ask-user card above composer: the agent's AskUserQuestion tool renders as the 1/2 card: numbered options (keys 1-9), "Other" with free text, Skip, Next, collapse, close.
- Status bar: project + branch, +N/-N pill, Create PR split button (Create PR, Commit, Commit & push, Copy branch name, Open in editor).
- Code home: "Welcome back, <name>", sessions list sorted by attention then recency with status labels, context chips (environment, folder picker, branch picker with worktree checkbox, add folder), suggestion banner, mascot.
- Permission prompt: modal-like card above the composer showing the exact command/path/diff, buttons: Allow once, Allow for session, Always allow (writes a rule), Deny, plus Deny with feedback text.
- Desktop notification + sidebar amber dot when a session needs input or finishes in the background; red triangle on errors with a retry.
- Sessions run concurrently in separate agent loops; closing the window keeps running if "run in tray" is enabled.
Side panels (resizable, one or more docked on the right): Terminal (real pty tabs, cwd = session worktree), Changes (file list, unified/split diff, stage/unstage/revert per file and hunk, commit message box with AI-suggested message), Files (tree with git status, open read-only preview), Browser (embedded preview for local dev servers with URL bar, reload, open externally), Background tasks (as in reference 12).

## AGENT RUNTIME (main process, no UI dependencies, fully unit-tested)
- Loop: stream model response, execute tool calls (parallel when safe), append structured results, repeat until no tool calls; cancellation, timeouts, retries, loop/budget guards, error recovery that never crashes a session.
- Tool registry with unique IDs, Zod schemas, descriptions, permission class (read / write / exec / network), execution limits, cancellation, structured output, and logging. Built-ins: Read (line ranges, binary/image handling, size caps), Write, Edit (exact unique-match replace, clear failure messages, read-before-edit enforcement), MultiEdit, Glob, Grep (ripgrep), Shell (Git Bash if present on Windows else PowerShell; persistent cwd/env, streamed output, timeouts, output truncation with full log on disk, background mode), BashOutput/KillShell, WebFetch, WebSearch (provider-dependent, hidden if unsupported), TodoWrite (renders as a live task list in the transcript), Task (sub-agents with isolated context and their own tool allowlist), AskUserQuestion, ExitPlanMode.
- Permission engine: modes Ask, Auto-edit, Plan (read-only until plan approved), Auto (approves low-risk actions by rule; always asks for destructive/out-of-project actions), and Bypass (hidden behind a settings toggle with a confirmation dialog). Allow/ask/deny rules with glob patterns per tool (e.g. Shell(npm test:*), Edit(src/**)), stored at user, project (.graft/settings.json), and local scope. Path sandboxing: writes outside the project/worktree always require approval. Detect dangerous commands (recursive deletes, force pushes, credential file access, curl|sh) and never auto-approve them.
- Context management: token accounting per provider, automatic compaction near the limit (summarize older turns while preserving task state and file list), manual /compact, tool-result truncation policy.
- Memory and config: GRAFT.md at user and project level plus nested directories (also read AGENTS.md / CLAUDE.md as compatibility fallbacks), /init generates GRAFT.md, custom slash commands from .graft/commands/*.md with frontmatter and $ARGUMENTS, skills folder, hooks (PreToolUse, PostToolUse, UserPromptSubmit, Stop) with command handlers, MCP client (stdio and streamable HTTP, OAuth where required, tools namespaced mcp__server__tool, per-server enable/disable and status UI).
- Built-in slash commands: /clear /compact /model /effort /permissions /mcp /init /review /resume /cost /rewind /help /config.

## GIT, WORKTREES, CHECKPOINTS
- Worktree toggle creates `git worktree add` under ~/.graft/worktrees/<repo>/<session-slug> on a new branch (graft/<slug>); cleanup on archive with a dirty-state safeguard (never delete uncommitted work without explicit confirmation).
- Checkpoints: before each user turn, snapshot the working tree to a hidden ref (git plumbing, no user-visible commits, no changes to the user's index). /rewind or a per-message Rewind action restores files, conversation, or both, with a preview of what will change.
- Diff stats are live-computed and cheap (debounced, cached). Create PR uses the gh CLI if installed, else pushes and opens the compare URL; clear errors when not authenticated.
- Never run destructive git commands without explicit user approval.

## SETTINGS
Profile (name, avatar), Providers (multiple keys, test, remove, default), Models (defaults, effort, custom model IDs), Permissions (rules editor, default mode), MCP servers, Hooks, Memory files editor, Appearance (theme, UI and code font size, reduced motion), Shortcuts (rebindable), Notifications, Data (export all, clear, open data folder, reset onboarding).
Shortcuts: Ctrl+N new, Ctrl+K search, Ctrl+B sidebar, Ctrl+` terminal, Ctrl+Shift+D changes, Ctrl+L focus composer, Esc interrupt, Shift+Tab cycle mode, 1-9 in menus/cards.

## DESIGN RULES
Restrained, dense, product-quality. No gradients as decoration, no glassmorphism, no glow, no emoji icons, no cards-in-cards, no fake stats, no decorative animation. Transitions 120-250ms, reduced-motion respected. Every view has real loading, empty, and error states. Full keyboard navigation, visible focus rings, ARIA on menus/dialogs/cards, WCAG AA contrast. Verify layout at 900x600 min window through 1920x1080: no overflow, clipping, or overlapping controls.

## ENGINEERING RULES
- Understand before editing; small focused diffs; no placeholders, TODO stubs, dead code, fake data, or silent error swallowing. Fix root causes; add a regression test for every bug you fix.
- Structure: src/main (agent, tools, providers, git, pty, db, ipc), src/preload, src/renderer (features/*, components, styles), src/shared (types, zod contracts). Agent core must be runnable headless in tests.
- Errors carry context. Validate all IPC input. Avoid unneeded dependencies.

## BUILD ORDER (each phase ends with its verification gate before moving on)
1. Scaffold + tokens from screenshots + design system primitives. Gate: typecheck, lint, app launches.
2. Main-process core: DB, settings, secure key storage, provider layer with FakeProvider tests, tool registry + all tools, permission engine, agent loop. Gate: unit tests for every tool, permission rule matching, loop cancellation/retry, compaction.
3. Git layer: worktrees, checkpoints, diff stats, rewind. Gate: tests against real temp git repos.
4. Onboarding flow + app shell + sidebar. Gate: Playwright E2E for first run through landing in Code mode, and resuming mid-flow.
5. Code session UI: transcript, tool lines, composer, menus, ask-user card, permission prompts, status bar. Gate: E2E with the scripted provider covering a full edit-and-approve turn, interrupt, rewind.
6. Side panels: terminal, changes, files, browser, background tasks. Gate: E2E for terminal echo and diff stage/revert.
7. Chat mode, Projects, Artifacts, Scheduled, Customize (commands, skills, MCP, hooks, memory). Gate: tests + E2E for MCP server connect with a local test server.
8. Settings, notifications, tray, updater wiring, packaging. Gate: electron-builder produces a Windows installer; launch the packaged app and smoke-test onboarding and one real session against a real provider if a key is available (otherwise state clearly that it was unverified).
9. Final pass: review the full diff as a hostile PR reviewer (security, races, leaks, a11y, responsive), grep for leftover markers and test doubles in shipped code, remove leftovers.

## DEFINITION OF DONE
Typecheck, lint, all unit tests, all E2E tests, and the production build pass with evidence shown. Report only: Implemented / Verified (exact commands run and results) / Remaining (genuine gaps only). Do not claim anything works that you did not run.
