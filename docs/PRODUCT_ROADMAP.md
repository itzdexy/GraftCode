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

### 0.6.13 (2026-10-06)

- **What fills the context** (`src/main/agent/contextBreakdown.ts`). The next request is
  split into seven parts, estimated from the text with the estimator compaction uses:
  system prompt, built-in tools, MCP tools (only the loaded ones, since only they are
  sent), the user's messages, replies, tool results, reasoning. It reads the history as it
  is sent, so output removed in 0.6.12 is not counted. `Session.contextReport` builds it
  without keeping a prompt, asking a model or touching a message; `sessions:context` is its
  channel.
- **`/context`** prints the total against the window, a line a part, and `Estimated from
  the text; the provider counted N.` It works in chats too. The context popover shows the
  same parts as bars against the largest (`contextModel.ts`, `ContextUsage.tsx`), worked
  out each time it opens.
- **Needs you** (`needsYou`, `withoutThose`, `Sidebar.tsx`). Sessions with status
  `needs-input` or `error`, not archived, newest first, above the other lists and listed
  once. A code session there names its project. Hidden while a filter is on. Search and
  the filter sit in the topmost header. The session that is open is left in its place: in
  Ask mode its row would otherwise move up and back with every approval (seen in the
  end-to-end screenshots).
- **A rewind undoes a summary or a `/clear`.** The messages a summary replaced, or a
  `/clear` cleared, carry the id of that summary or of the note `/clear` leaves
  (`meta.compactedBy`, `markCompacted(…, by)`); when a rewind deletes it,
  `restoreCompacted` brings them back into what is sent. Before, they stayed on screen and
  out of the model's context, and after 0.6.12 the steps a summary kept would have been
  sent without it.
- **Local models are measured against what is asked for** (`ollama.ts`). The adapter
  reported the trained length as the window and asked the server for at most 32,768, so
  the ring and compaction ran up to four times late while the server dropped old messages
  silently. The window is now `min(trained, 32,768)`, or the size set for the model under
  Custom model IDs (the adapter ignored those before), and `num_ctx` is that window. The
  description reads `32K of 128K context`. A model the server passes on to a hosted one
  (`remote_host` on its tag, or a name ending in `cloud`) gets its whole window.
- **A sound switch** (`notifications.sound`, default on; `notificationPlan`). Off makes
  every notification silent, the sample one included; a finished session was and is silent.
- **Catalog** regenerated: 212 providers, 7,557 models.

### 0.6.12 (2026-10-06)

- **Old tool output goes first** (`src/main/agent/prune.ts`). When the context passes 80% of
  the window, the session keeps the newest results worth `min(40,000, 25% of the window)`
  estimated tokens (the latest step's always) and sends each older result of 200 tokens or
  more as `[The output of this <tool> call was removed to save context. Run it again if you
  need it.]`. When that brings the context to 60% or less, nothing is summarized. This is
  how the history is sent (`Session.history`, `pruneBeforeSeq`), not how it is stored: no
  message is changed, and every call keeps a result.
- **A rewind pulls the cutoff back.** The store hands the numbers of deleted messages out
  again, so `Session.deleteMessagesFrom` moves the cutoff to the first deleted message.
- **A summary keeps the recent steps** (`compactionCut`, `modelOrder`). The newest messages
  worth `min(15,000, 10% of the window)` tokens stay as they are, starting at a reply; the
  summary is stored after them and sent ahead of them, and ends with `The most recent steps
  follow this summary unchanged.` Kept steps keep their thinking. With fewer than two
  messages to summarize, or after the provider refused a request as too long, everything is
  summarized as before. `/compact` does the same.
- **A backup model** (`defaults.fallbackModel`, `LoopHost.fallback`, `Session.backupFor`).
  After `overloaded`, `rate_limit`, `server` or `network` survived the retries and before
  any output, the turn continues once on the backup, without the first model's thinking,
  and a notice says so. From then on the turn is measured against the backup's context
  window and summarized by it. No switch in incognito chats, for agents of a group or
  sub-agents, when the backup is the failing model, can't be found, or can't call tools the
  turn offers. Settings → Models has the choice and `None`; with none chosen the list marks
  no row at rest (`ModelListbox`), so the first model does not read as a choice.
- **Fixed:** the plan card in the transcript showed the plan as offered under "Approved"
  after the user had edited it. It shows the agreed plan and "Approved with your changes"
  (`planShown`). Found in the end-to-end screenshot of 0.6.11.
- **Catalog** regenerated: 212 providers, 7,557 models.

### 0.6.11 (2026-10-06)

- **The current plan of a session** is read from its messages (`src/shared/plans.ts`): the
  newest plan the user approved, as approved, after the last `/clear` (which now marks its
  message with `meta.cleared`). A rejected plan changes nothing and a rewind to before the
  approval removes it. Nothing new is saved, so there is no migration.
- **Approve with changes.** The plan card has `Edit plan` (`PermissionCard.tsx`,
  `planModel.ts`): a text box of at most 50,000 characters, and `Approve plan` is disabled
  while it is empty. The answer carries the user's version (`PermissionResponse.plan`), the
  tool result says `carry out their version:` followed by it, and the transcript keeps the
  agreed plan. An unchanged or whitespace-only edit is an ordinary approval.
- **The plan stays in view.** `PlanBar` above the message box reads `Plan: <title>` and
  `<done> of <total> done` when the session has tasks; it opens the plan with `Copy`.
- **A summary carries the plan** word for word, under `The plan you and the user agreed on
  (follow it):` (`summaryMessageText`), so compaction can't lose or reword it.
- **`/plan [what to plan]`** switches a code session to Plan mode and sends `Plan this
  before changing anything: …`; alone it only switches. A command file can't replace it. In
  a chat it says that Plan mode belongs to code sessions.
- **A better brief.** The prompt's Plan mode section asks for a goal, ordered steps with
  their files, the checks, and the risks, and for up to three questions with
  `AskUserQuestion` when a request leaves a real choice open.
- **Catalog** regenerated: 212 providers, 7,554 models.

### 0.6.10 (2026-10-05)

- **What a conversation read and found** is worked out from the tool results it already
  stores (`src/shared/sources.ts`): a page is read when `WebFetch` returned it below 400,
  found when a search returned it. Addresses are compared after dropping `http`/`www.`, the
  fragment, a trailing slash and tracking parameters. Nothing new is saved.
- **Marks on citations and a sources card.** A citation pill says in its tooltip and its
  accessible name whether its page was opened, only found, or neither (dashed border);
  nothing is marked in a conversation with no sources (`Markdown.tsx`, `sourcesModel.ts`).
  A finished turn that read pages ends with `SourcesCard` ("Read 3 pages").
- **`/research`** sends a seven-step routine (`researchPrompt`), in chats and code sessions.
- **Researchers in chats.** A chat with web access has `RunAgents`; every agent of its
  group gets `WebFetch` and `WebSearch` and nothing else, whatever its role, and a group
  that carries `verify` or `writes` is refused. The pages its agents read and found come
  back with the result (`display.sources`) and count as the conversation's own.
- **A page that moved** is known by both addresses: `WebFetch` records the one asked for
  (`display.requested`), so a link to either counts as opened.
- **Reading stays on the web.** In a chat, a page on this computer or a private network asks
  first (`isPrivateAddress`, `engine.ts`). `WebFetch` follows redirects by hand and never
  from the web into a private address (`redirectProblem`); where pages are read without
  asking, a public-looking name that resolves to a private address is refused
  (`pointsInside`).
- **`localhost` by name.** In the app a request to `http://localhost:port` failed when the
  server listened on the other of this computer's two addresses (seen in the container:
  "fetch failed"). `fetchPage` tries 127.0.0.1 and ::1 by number before giving up.
- **Catalog** regenerated: 212 providers, 7,552 models.

### 0.6.9 (2026-10-05)

- **Documents from chats.** `CreateFile` builds a file named `.pdf`, `.docx`, `.pptx` or
  `.xlsx` from the Markdown or rows the model wrote (`src/main/chat/documents/`:
  `markdown.ts` parses, `html.ts`, `docx.ts`, `pptx.ts` and `xlsx.ts` convert, `index.ts`
  holds `DocumentMaker` with the 2 MB and 60-second limits). The converters and their
  libraries are separate chunks loaded on first use, so startup does not pay for them.
- **PDFs are printed** by `pdfPrinter.ts`: a hidden window with scripts off and the renderer
  sandbox on, in a private in-memory session that serves only the page being printed and
  cancels every other request. The page's content policy is sent as a header too. Prints go
  one at a time; `disposePrinter()` gives up on one when the app's window closes.
- **What a model's text cannot do in a document.** Raw HTML is shown as text. A link is kept
  only when it is a web or mail address. A picture is placed only by the plain name of a
  file of that chat; one from the web becomes a link. Characters the formats forbid are
  dropped, so a file always opens. A cell that only starts like a formula stays text, and
  a number longer than 15 digits stays text instead of being rounded.
- **Slides**: `---` between slides, first heading as title, list items as bullets with
  their nesting, the first table as a table, one picture on the right half, `Note:` lines as
  speaker's notes. **Sheets**: CSV, or a JSON object of sheet name to rows; typed numbers,
  booleans and formulas, a bold heading row, column widths from the content.
- **Checked with other programs, not only our own tests.** Samples were opened with
  python-docx, python-pptx and openpyxl, and rendered by LibreOffice in a container, which
  also computed the formulas. That found three faults the unit tests had passed: formulas
  stored with a doubled `=`, control characters making a file unreadable, and ragged table
  rows. The printer was run in real Electron on Windows and its PDFs read back.
- **Context sizes that are true.** A connection added by typing a provider's address named no
  preset, so the catalog was never asked and every model there got 32,768 tokens (seen on a
  typed NVIDIA address: a 1,048,576-token model at 32K). `ProviderCatalog.presetsForUrl` now
  finds the entries that answer at an address. `contextSize` (`openaiChat.ts`) takes the
  best source that says: what the server reports under the names servers use
  (`context_length`, `context_window`, `max_model_len`, `meta.n_ctx_train` and others), then
  the provider's entry, then, for a hosted model only, what most providers give for a model
  of that name (`typicalContext`). When nothing says, 128,000 is assumed for a hosted model
  (nine in ten catalog models have that or more) and 32,768 for a server on this computer,
  and the model's description says "(assumed)". `formatTokens` no longer prints 128,000 as
  "125K". The session's ring measures against the selected model, not the limit recorded at
  the last turn (`contextLimit`).
- **A reply budget a server refuses is lowered and retried** (`smallerReplyBudget`): the room
  the refusal leaves, or the most the server says it allows, remembered for that model. A
  prompt that is itself too long is still left to compaction.
- **After review** of the documents round (one reviewer, no critical findings): office files
  are saved only when Graft built them (`CreateFile` refuses bytes under those names,
  `RunCode` cannot write them); a formula that reaches outside the workbook (`WEBSERVICE`,
  DDE, another file, a share, a link that is not a web address) stays text; semicolons
  between arguments become commas and newer functions get their `_xlfn.` prefix; CSV may
  have spaces after its commas; numbered lists in a .docx count from where the text says;
  slides keep hard line breaks; a picture the chat does not have fails the build with a
  sentence instead of vanishing; `<br>` is a line break; a forbidden character written as a
  character reference is dropped; long numbers in JSON stay text.
- `fileCardModel.ts` gives the files card an icon per kind of file.
- `scripts/e2e-docker.mjs` (`npm run test:e2e:docker`) runs the end-to-end tests in a Linux
  container from the working tree, for computers where they cannot drive Electron.
- **Catalog** regenerated: 212 providers, 7,552 models.

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

- The parts of the context are estimates by characters (about 3.5 a token): they say which
  part is large, not what a provider bills, and their sum differs from the provider's
  count, which is shown beside them. Tool schemas are counted as written out in JSON, which
  is not how every provider encodes them. Spend by day is still not shown.
- A rewind brings back only what was replaced from 0.6.13 on: messages summarized or
  cleared by an earlier version carry no `compactedBy` and stay out of the context.
- Needs you lists by status only: a session whose turn finished with a question in plain
  text is not there, since nothing marks it as waiting. A session that stopped with an
  error stays there until it is continued, retried or archived, also across restarts; a
  project whose only session is listed there has no header, and so no "new session in this
  project" button, for as long as it is.

- A session has one current plan: a second approved plan replaces the first in the bar and
  in summaries, and there is no history of plans beyond the transcript. A plan is not saved
  as a file in the project. The bar's progress counts the session's tasks, which the agent
  writes itself and which need not match the plan's steps. `/plan` in a chat only explains;
  the chat's command menu still lists it.

- Research reads HTML and text only: a PDF on the web can't be read. A mark on a citation
  says what this conversation opened, not whether the page says what is claimed. Search
  results that are redirect links (one provider's own search) are compared by the redirect,
  so a link to the page itself reads "not opened". The `RunAgents` description a chat sees
  is the code session's, with roles a chat has no use for.
- The check against names that resolve to private addresses looks the name up before the
  request, and the request looks it up again: a name that changes its answer in between is
  not caught. A hosts-file name that points at this computer can't be read from a chat.
- Documents are built in chats only; a code session writes files with its own tools. The
  files were opened with LibreOffice and three Python readers, not with Microsoft Office.
  Slides hold one picture and one table each and their text is not measured, so a long
  slide runs off its edge. Sheets have no dates, number formats or charts. There is no
  table of contents, cover page or page-break control, and equations are plain text. The
  PDF uses the computer's own fonts.
- `src/main/agent/session.ts` is 1,980 lines: turns, slash commands, compaction, the
  loop host, and now the mission controller and agent-group wiring. Split the loop host
  and the mission controller out before adding more.
- The cutoff for removed tool output lives in memory: a restarted session sends old output
  in full again until it next fills up. Removing output changes the start of the history
  once, so a provider's prompt cache is rebuilt from that point. The estimate of what
  removing frees is by characters, not the provider's count. In the transcript a summary
  appears after the steps it kept, where it was made, though the model reads it first.
- The backup model finishes one turn: the next turn asks the session's own model again and
  waits through its retries before switching. Agents of a group and sub-agents have no
  backup. A backup without vision gets a history with screenshots as it is.
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
- The local-model adapter's context handling (0.6.13) is checked against a recorded
  server, not a live one: nothing was running here. A model is taken for hosted when its
  tag carries `remote_host` or its name ends in `cloud`; a size set for a model above what
  the computer can hold makes the server slow or fail to load it, and Graft does not
  warn about that.
- Context sizes for a model on an unknown gateway are estimates from other providers. A
  server that allows less is found out by a refused request, not before.
- Newer spreadsheet functions are stored with their prefix from a list (`NEWER` in
  `xlsx.ts`); functions that take a `LAMBDA` or name variables (`LET`) are written as typed
  and may show `#NAME?` until re-entered. Nothing here was opened in Microsoft Excel.
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
| Prune old tool output before summarizing | OpenCode session compaction, Claude Code | Shipped in 0.6.12, as a view of the history: nothing stored changes |
| Fallback model per session | Roo Code and Goose provider settings | Shipped in 0.6.12 as one backup model in Settings, used once a turn |
| Worktree per agent that writes | Claude Code, Cursor | Open; unlocks parallel implementers and best-of-N |
| Best of N: one task on several models, pick the winner | Cursor, Codex | Open; needs worktrees per agent |
| Sessions grouped by state: running, needs input, ready, blocked | Codex app, Cursor's agents window | Open |
| A sound and a notification for done, approval needed and question, with "only when unfocused" | Codex (a much-requested issue), Claude Code | Open; small. Graft notifies but has no sound |
| Comments on a diff that go back to the agent | Cursor and Codex review | Open |
| Where the context and the money went, by category | Claude Code `/context` and `/cost` | The context half shipped in 0.6.13 as `/context` and the popover; spend by day is open |
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

The five rounds designed in `docs/superpowers/specs/2026-10-05-next-rounds-design.md` and
planned task by task in `docs/superpowers/plans/` are done: chat documents (0.6.9),
research (0.6.10), plans that last (0.6.11), long sessions (0.6.12), attention and context
(0.6.13). What comes next:

1. Split the loop host and the mission controller out of `session.ts` (1,980 lines): the
   last three rounds each added to it.
2. A worktree per agent that writes, merged back by the main agent: parallel
   implementers, then best-of-N.
3. Diagnostics after edits (LSP), starting with TypeScript.
4. Keep the cutoff for removed tool output across restarts; a backup model for agents of a
   group; spend by day.
5. Gemini `thinkingLevel`; measure the `ToolSearch` threshold on real setups; MCP elicitation
   and @-mentioning resources.
6. Diagrams and equations in replies; reading PDFs from the web.
