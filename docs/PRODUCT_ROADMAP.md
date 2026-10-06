# Graft product roadmap

The running record of the improvement routine: what shipped, what is weak, what was
researched and what comes next. Read it before choosing work, and update it at the end
of every run. Features that predate this file are described in the README.

## Identity

Why someone picks Graft over Claude Code, OpenCode, Cursor or Cline:

- It runs on any model, including small and local ones, and is tuned so those models
  succeed (forgiving edits, overflow recovery, catalog-driven capabilities).
- It verifies its own work with the project's checks, a real browser, and now with
  commands that gate an agent's work and a mission's end.
- It is a desktop app with a sandbox, checkpoints and permissions a non-expert can trust,
  and it shows what its agents are doing instead of asking for trust.

Work that makes weaker models reliable, or makes verification stronger, comes first.

## Completed

### 0.6.8 (2026-10-04)

- **Agents that write, side by side.** `RunAgents` takes `writes` paths per agent. The
  scheduler (`paths` on an `orchestrator.ts` node) runs agents whose paths can't name the
  same file together, and never beside an agent that may change anything. Each such agent
  has its own `FileStateTracker`, so it reads a file before it changes it, and its edit
  calls are refused outside its paths by a wrapper around `decide` (`agentGroup.ts`,
  `writeScope.ts`). The overlap rules are in `src/shared/writeScopes.ts`.
- **Tool calls batched.** `toBatches` (`toolBatches.ts`): neighbouring calls that may
  overlap (safe and approved) run together, every other call alone and in order. Before,
  one call needing approval serialized the whole response.
- **`context_window` recovery.** A reply cut off by a full window compacts once and the
  turn goes on (`loop.ts`).
- **OpenAI Responses API** (`openaiResponses.ts`) for `-pro`, Codex and deep-research
  models, chosen by id and learned from the "only supported in v1/responses" error.
  Stateless (`store: false`): the output items, reasoning included, are saved with the
  message and sent back whole. Retries without `reasoning.summary` or `include` when an
  account may not use them. Codex models are no longer filtered out of the list.
- **Catalog** regenerated: 212 providers, 7,553 models.
- **MCP beyond tools.** A server's `instructions` go into the prompt (quoted line by line,
  capped, marked as the server's words). `mcp__resources__list` and `mcp__resources__read`
  exist while a visible server has resources, limited to the session's project through
  `ToolContext.mcpRoot`. Prompts are `/mcp__server__prompt` commands (`commands:list`
  source `mcp`). `structuredContent` and audio show in results. Roots go to stdio servers
  only: a remote server isn't told the paths of local projects. The server row shows its
  prompts and resources. New fixture server `tests/fixtures/mcp-rich-server.mjs`, and a
  real-app E2E.
- **Tool search for big MCP setups** (`toolSearch.ts`). When MCP tool definitions weigh
  more than 10K tokens (or a tenth of the window), they wait: the prompt lists the servers
  and `ToolSearch` loads tools by words or `select:name`; a server's name alone loads all
  its tools. The choice is sticky for the session; sub-agents get what was loaded.
- **Edit errors show the file's lines** at the nearest match.
- `video/`, a separate Remotion package that appeared in the tree, is ignored by ESLint.

### 0.6.7 (2026-10-04)

- **Pictures and clips in the Files panel.** `readPreview` marks media by name instead of
  calling it binary or too large; the panel loads it through `files:previewUrl`, which
  grants the preview protocol one file (`ArtifactServer.urlForFile`), not its folder.
  `src/main/files/fileTree.ts`, `src/renderer/src/features/panels/FilesPanel.tsx`.
- **File actions.** A menu on every row (button or right-click) and on the preview: copy
  path, copy relative path, copy the picture, show in folder, open with its app, open in
  the editor, add to the message. One rule decides what a click may open
  (`canOpenProjectFile` in `src/shared/chatFileTypes.ts`), used by both processes.
  `FileMenu.tsx`, `fileActions.ts`.
- **The Read step shows the picture** it read (`ReadImage` in `ToolDetail.tsx`).

### 0.6.6 (2026-10-04)

- **Groups of agents.** `RunAgents` runs a graph of agents with roles (13 built in, plus
  custom agents). The scheduler (`src/main/agent/orchestrator.ts`) knows nothing about
  models: it validates the graph, runs independent nodes side by side up to a limit,
  runs nodes that write or drive the browser one at a time, retries only provider
  failures, enforces a time limit per node, skips what depended on a failure, and can
  stop one node while the rest go on. `agentGroup.ts` turns a node into an agent loop
  with a fresh context, the tools of its role (`roles.ts`), a model chosen by
  `modelRouter.ts` (a role's assigned model, else the cheapest capable model of the same
  provider for quick work when routing is automatic, else the session's), an optional
  token budget, and an optional `verify` command that is run through the normal
  permission path and decides whether the work counts (three rounds). Every agent's
  record is stored (`agent_runs`, migration 3) and survives restarts.
- **Agents panel.** `src/renderer/src/features/panels/AgentsPanel.tsx` draws each group
  as a layered graph that updates live (`agentGraphLayout.ts`), with an inspector for
  the model and why it was chosen, limits, tools, files, tokens, cost, check, brief,
  report, failed attempts and steps, and a Stop for one agent (`sessions:stopAgent`).
  Settings → Models → Agents sets routing, a model per kind of work, parallelism, the
  token budget and retries.
- **Missions.** `/mission` starts an objective with criteria and check commands that
  only the user sets. `src/main/agent/mission.ts` holds the rules as pure functions;
  the session carries them out: a turn that ends without finishing is followed by the
  next with the mission and the agent's notebook restated (so a compacted context loses
  nothing), a report of "done" runs the checks, and a failure goes back with its output.
  It pauses on stop, failure, a blocked agent, a stuck turn or the turn limit, resumes
  with more turns, and is stored (`missions`, migration 4). `MissionUpdate` is offered
  only while a mission is open. UI: `MissionBar.tsx`, `MissionDialog.tsx`.
- **Code structure.** The `Symbols` tool (`src/main/tools/search/symbols.ts`,
  `symbolPatterns.ts`): outline, definition, references by file with tests marked,
  importers (following `tsconfig` path aliases) and the tests of a file, for twelve
  languages, on top of the bundled ripgrep. Read-only, so explorers and Plan mode use it.
- **Generated media.** `GenerateImage` (OpenRouter, OpenAI, Gemini) and `ComfyUI`
  (status, models, nodes, saved and ad-hoc workflows, images and video) in
  `src/main/media/` and `src/main/tools/media.ts`; Settings → Images; offered only when
  set up, never in incognito chats, refused in Plan mode, asked about in Ask mode.
- **Reverse engineering.** A Ghidra integration (pyghidra-mcp, launched as its
  documentation says) and `/decompile`: one function per fresh agent, the project's own
  match check as the `verify` command, a cap on attempts, no editing of the target.
- **Motion and streaming.** A CSS-only motion system (spring easing, enter and exit
  animations for menus, dialogs, panels and disclosures), a Motion setting that can
  override the operating system, frame-batched streaming with a paced reveal, chunked
  Markdown so settled text is never parsed again, and a fix for a finished reply being
  rebuilt twice.
- **Real MCP tests.** `tests/unit/mcp.live.test.ts` (opt-in) starts actual servers
  through `McpManager` and checks every catalogue entry against its registry or endpoint.

### 0.6.5 (2026-10-04)

- **Indentation-tolerant edits.** `Edit` and `MultiEdit` fall back to matching
  `old_string` line by line with each line's surrounding whitespace ignored, accept the
  match only when it is the single one, and shift `new_string` to the file's indentation.
  The result tells the model which lines matched. `src/main/tools/fs/edit.ts`
  (`applyLooseEdit`).
- **Context overflow recovery.** A `context_length` error with no output now compacts
  the conversation and resends once, even when the model's window is unknown (0). It
  follows the "compact automatically" preference. `src/main/agent/loop.ts`,
  `maybeCompact(…, overflow)` in `src/main/agent/session.ts`.

## Known weaknesses and technical debt

- `src/main/agent/session.ts` is 1,690 lines: turns, slash commands, compaction, the
  loop host, and now the mission controller and agent-group wiring. Split the loop host
  and the mission controller out before adding more.
- Compaction is all or nothing: one summary replaces the whole history. Old tool output
  is never pruned first, so long sessions pay for a summary sooner than they need to.
- Agents that change files with no paths of their own share the session's working tree
  and run one at a time. Writers given `writes` paths run together in that same tree, kept
  apart only by their paths: the scope is enforced on the edit tools, not on Shell commands
  (the agent is told to use the edit tools), and patterns are compared by their literal
  prefix, so `src/**/*.ts` and `src/**/*.css` count as overlapping. There is no worktree
  per agent, which rules out best-of-N.
- The OpenAI Responses adapter and `ToolSearch` are tested against fixtures and recordings
  of the wire format (event names checked against OpenAI's documentation); nothing ran
  against a live OpenAI account. The 10K-token threshold for waiting MCP tools is a guess,
  not measured on real setups.
- Gemini 3 models take a `thinkingLevel`; the adapter still sends `thinkingBudget`, which
  works but doesn't match the levels the catalog lists for them.
- MCP: no elicitation or sampling; resources can't be @-mentioned in the message box;
  prompts are only in the `/` menu; a server's notes are read when a session's prompt is
  built, so a server that connects later is not in it.
- A finished group can't be re-run for one agent from the panel; Stop is the only live
  control. The graph has no pan or zoom, and a line that skips a step passes behind the
  agents in between.
- Missions: one per session. A rewind to the middle of a mission keeps its later
  notebook and state (only a rewind to before its first message removes it). Export is
  copy as Markdown.
- `Symbols` reads text with patterns. It has no types, so two unrelated things with one
  name are not told apart; bundler-only import aliases are reported as "possibly".
  There is no persistent index and no LSP.
- Image generation and ComfyUI are tested against fixtures of the HTTP APIs, not live
  services. The Ghidra integration's launch comes from its documentation and its
  package exists on PyPI, but it has not been run here (no Ghidra on the dev machine).
- The preview protocol reads a file whole, so media over 64 MB is not shown and video
  can't be seeked without loading it all. Text previews don't refresh when a file changes.
- No model fallback: when a provider stays down after retries the turn ends in an error.
- macOS builds are not published (GitHub Actions is blocked by an account billing lock).
- Loose edit matching ignores only leading and trailing whitespace per line. Differences
  inside a line (double spaces, escaped `\n`) still fail with the exact-match error.

## Researched ideas

From reading how Claude Code, Codex, Cursor and OpenCode work and what their users
praise and complain about (October 2026).

| Idea | Source | Status |
| --- | --- | --- |
| Chain of fallback matchers for edits | OpenCode `tool/edit.ts` (nine replacers) | Took the line-trimmed one only, with a uniqueness rule; the similarity-scored ones can edit the wrong block |
| Parallel agents with a panel to watch them | Claude Code sub-agents, Cursor's agents window, Codex | Shipped in 0.6.6 for agents that read; writers with paths of their own run side by side since 0.6.8 |
| Tool search for MCP servers with many tools | Claude Code MCP tool search | Shipped in 0.6.8 as `ToolSearch` |
| A loop that goes on until a condition holds | Claude Code and Codex goals | Shipped in 0.6.6 as missions, with the user's commands as the condition |
| One function per fresh agent with a machine check | Decompilation projects driven by agents (compile, diff, feed the failure back, cap the attempts) | Shipped in 0.6.6 as `/decompile` on top of `verify` |
| Prune old tool output before summarizing | OpenCode session compaction, Claude Code | Next |
| Fallback model per session | Roo Code and Goose provider settings | Open |
| Worktree per agent that writes | Claude Code, Cursor | Open; unlocks parallel implementers and best-of-N |
| Best of N: one task on several models, pick the winner | Cursor, Codex | Open; needs worktrees per agent |
| Sessions grouped by state: running, needs input, ready, blocked | Codex app, Cursor's agents window | Open |
| A sound and a notification for done, approval needed and question, with "only when unfocused" | Codex (a much-requested issue), Claude Code | Open; small. Graft notifies but has no sound |
| Comments on a diff that go back to the agent | Cursor and Codex review | Open |
| Where the context and the money went, by category | Claude Code `/context` and `/cost` | Open |
| A side question that doesn't derail the turn | Claude Code `/btw` | Open |
| Watch a pull request's CI and fix what fails | Claude Code desktop, Codex | Open |
| Sandbox by default instead of prompts | Codex (workspace-write sandbox, asks only to leave it) | Graft's container sandbox is opt-in; default-on is open |
| Diagnostics after each edit | OpenCode and Zed LSP integration | Open; large |
| Repository map from tree-sitter tags | Aider repo map | `Symbols` covers the questions without an index; a ranked map is open |

## The larger brief

The brief for this round described a development environment far larger than one
round. What exists now and what does not:

- **Exists as working slices:** multi-agent orchestration with a visual graph, model
  routing that explains itself, persistent missions, repository intelligence without an
  index, verification as a first-class step (agent checks, mission checks, project
  checks), generated media, an MCP platform with real tests, a transparent record of
  every agent's steps.
- **Not started:** a Monaco-based editor, a dockable workspace, a project graph view, a
  model lab for comparing models on a task, a browser QA lab with visual regression,
  remote execution, a workflow engine driven by files in `.graft/`, context modes with a
  view of what was selected and left out, an observability area, a replay timeline
  across a whole session.

## Next, in order

The next five rounds are designed in
`docs/superpowers/specs/2026-10-05-next-rounds-design.md` and planned task by task, one plan
a round, in `docs/superpowers/plans/`:

1. 0.6.9, `2026-10-05-chat-documents.md`: a chat makes a PDF, a text document, slides or a
   spreadsheet from what the model wrote.
2. 0.6.10, `2026-10-05-research.md`: `/research`, researchers in parallel in chats, a
   sources card, and a mark on cited links nobody opened.
3. 0.6.11, `2026-10-05-plans-that-last.md`: edit a plan before approving it; the plan stays
   in view and survives compaction; `/plan`.
4. 0.6.12, `2026-10-05-long-sessions.md`: remove old tool output before summarizing, keep
   the recent steps in a summary, a backup model.
5. 0.6.13, `2026-10-05-attention-and-context.md`: "Needs you" in the sidebar, what fills
   the context, a sound switch.

After those:

6. A worktree per agent that writes, merged back by the main agent: parallel
   implementers, then best-of-N.
7. Split the loop host and the mission controller out of `session.ts`.
8. Diagnostics after edits (LSP), starting with TypeScript.
9. Gemini `thinkingLevel`; measure the `ToolSearch` threshold on real setups; MCP elicitation
   and @-mentioning resources.
10. Diagrams and equations in replies; reading PDFs from the web; usage by day.
