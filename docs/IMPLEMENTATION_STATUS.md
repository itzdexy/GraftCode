# Graft Code implementation record

Updated 2026-10-09. Base: `d236a2949cee1ecbce4c8915deee56bc181e23bc`
(Graft 0.6.13), implemented as Graft 0.6.14. Release publication is separate from
the verified local installer. The full eight-milestone
assignment is not complete. Checkboxes describe verified implementation, not proposals.

## Repository assessment

The existing app is substantial; it has been extended in place. Electron 44,
React 18, TypeScript 5.9, electron-vite/Vite, Tailwind, Radix and Zustand form the
desktop UI. SQLite/better-sqlite3 persists sessions and settings; Zod validates
IPC and data boundaries. Native node-pty, ripgrep, Electron Builder and Updater
support terminals, search and packaging.

| Area | Existing implementation and remaining gap |
| --- | --- |
| Agent execution | Streaming tool loop, cancellation, permissions, queued messages, missions with command gates, fallback, compaction, pruning and rewind. `agent/session.ts` remains large; context state is now extracted. A complete durable execution journal/replay is still absent. |
| Providers | Native Anthropic, Gemini and Ollama; OpenAI/OpenRouter and configurable OpenAI-compatible adapters; custom model IDs, credential verification, retries, pricing and routing. Bundled Models.dev presets previously updated only at build time. Runtime refresh and durable account metadata are now added. |
| Collaboration | Custom agents, roles, groups, subagents and a live graph. Writing group agents and general/custom writing Tasks now use private checkouts with conflict-checked patch integration. Shell/MCP operations are not a universal OS path sandbox; recovery/cleanup controls still need expansion. |
| Tools | File edits, shell/PTY, search, checkpoints, diffs, project quality checks and an embedded browser. Revision checks and a real local TypeScript/JavaScript LSP client are now connected. Persistent repository indexing and semantic edits remain incomplete. |
| Research | Web search/fetch, citations, browser, attachments and document generation. Source-level PDF ingestion/traceable research-to-code and a comparison lab remain incomplete. |
| Workspace | Existing file/media viewer, changes, terminal, browser and command palette. Added Monaco editing, draft type checks and definition navigation. Split editing, completion/refactoring and persistent editor layouts remain incomplete. |
| Experience | Six palettes with light/dark variants, accents, motion preferences and Scion idle/thinking states. Custom themes and a full event-driven Buddy framework remain incomplete. |
| Security/infrastructure | Isolated preload, validated IPC, OS-backed key encryption, permission rules, trust, optional Docker/Podman command sandbox, migrations, schedules, updater and CI/release workflows. The optional sandbox is not universal OS isolation for all tools. |

## Implemented change groups

### Foundation and reliability

- Durable context pruning: migration 5 stores each session's cutoff. Restart,
  `/clear`, deletion and rewind preserve the intended context shaping without
  deleting original tool output. `agent/contextState.ts` centralizes that state.
- File revision protection: Write/Edit/MultiEdit compare the content they loaded
  before replacing it; new-file creation is exclusive. Read tracking hashes
  content as well as checking size/mtime, catching edits with restored timestamps.
  Original file permissions are retained on replacement.
- Credential redaction covers common token fields, bearer credentials and URL
  userinfo. Provider instance fingerprints hash the full key, fixing collisions
  between rotated keys with the same length and suffix.
- Retries respect a provider's Retry-After: when it exceeds the retry budget,
  the error is surfaced instead of retrying prematurely.
- Electron shutdown logs drainage stages. The Sites preview HTTP server closes
  unfinished connections so quitting cannot wait indefinitely on them. A real
  partial HTTP request reproduced this defect before the fix.
- CI now checks Windows/macOS/Linux; release packaging is gated by typecheck,
  lint, unit tests and Electron E2E. Existing migration history is untouched.

### Automatic model management

- `providers/catalogData.ts` validates bundled/cached/upstream metadata and
  normalizes data only. Remote scripts, SDK names, overrides and credentials are
  not imported or executed. Explicit false capabilities remain false; unknown
  catalog evidence is represented by null rather than an invented capability.
- `providers/catalogSync.ts` refreshes a fixed HTTPS Models.dev source with a
  30-second timeout, cancellation, 32 MiB limit and conditional HTTP requests.
  Concurrent refreshes share one operation. Atomic, versioned snapshots retain a
  previous verified copy; malformed data/network failure preserves usable metadata.
- Startup uses bundled/verified cached data immediately. Automatic refresh defaults
  to 24 hours and can be disabled or configured. Settings → Providers has real
  refresh controls, status, validation time, changes and failure feedback over IPC.
- Migration 6 persists discovered models per configured provider. Outages/auth
  failures and omissions retain prior metadata with an availability explanation.
  An omission never confirms retirement and never silently switches a conversation.
  Unavailable retained entries are disabled in selection/routing. Deprecation is
  labeled separately and remains selectable. Custom IDs remain explicit unverified
  choices. OpenRouter's public list does not claim account-specific access.
- Catalog changes invalidate provider caches. A response started before a
  provider configuration/catalog change cannot repopulate the replacement cache.
- Native OpenAI discovery reads the documented `shutdown_date` only from its
  HTTPS API endpoint, with redirects rejected. Valid future dates show deprecation;
  dates whose whole UTC day has passed disable the model as confirmed retired.
  Evidence survives omission, outages and restart, and is re-evaluated on cache reads.
  Proxies/custom-compatible endpoints cannot supply authoritative OpenAI evidence.
  No conversation or selected model is silently replaced; the picker explains the
  shutdown and directs the user to choose a replacement. Other providers' official
  lifecycle data and model-specific replacement recommendations remain incomplete.

### Writing-agent isolation and integration

- `agent/workspaces.ts` snapshots current working files into distinct Git worktrees
  for writing group roles and general/custom writing Tasks. Dirty working files are
  included without moving HEAD or changing the user's staged index. Non-Git folders
  use the existing private checkpoint repository. Selected project subfolders stay
  confined to their corresponding directory in the checkout.
- `agent/workspaceHost.ts` gives each writer its own file tracker, shell session,
  working directory and hook runner. Direct file writes reject parent-checkout,
  Git-metadata and symlink escapes. Existing permission rules are evaluated against
  the corresponding project paths; configured Docker/Podman execution is inherited.
- Successful writers produce binary-capable patches; integration is serialized per
  destination and checks the original revisions of every changed file. Changed
  destination files or out-of-scope/ignored tool edits retain the checkout and patch
  for review instead of reporting success or overwriting the user. Integration does
  not stage files or merge/reset the user's branch. Git snapshot operations disable
  repository hooks and fsmonitor commands.
- Agents panel shows the private path, branch, integration/recovery state and patch
  location; records persist across reload. Failed/cancelled work and manifests remain
  on disk. Restart recovery marks interrupted working agent records as retained.
  Dedicated retry/integration/cleanup controls are still needed; successful checkouts
  are retained as well, so disk use grows until manually reviewed and removed.

### Local language intelligence and editing

- `languages/servers.ts` runs pinned TypeScript 5.9.3 and
  typescript-language-server 5.1.3 over real JSON-RPC/LSP. The `SemanticCode` tool
  resolves imported definitions/references, hover, outlines and current file
  diagnostics. Trust is enforced in both the agent tool and editor IPC.
- Servers start on demand, allow at most two active project clients and 64 open
  documents each, expire after idle time, and drain at shutdown. Queries have
  deadlines and cancellation; invalid/missing diagnostics never mean "clean."
  Plugins and automatic type acquisition are disabled, child environment variables
  are restricted, server-requested edits are rejected, and output paths stay in
  the project after canonical symlink resolution. Real servers, imports, aliases,
  shadowing, edited diagnostics, separate projects and cancellation are tested.
- The Files panel lazy-loads Monaco with local bundled assets and the existing
  strict CSP. Text saves preserve BOM, line endings and permissions, check SHA-256
  revisions, reject Git metadata/path escapes/binary or lossy text, and keep drafts
  on failure. Complete existing UTF-8 files up to 512 KiB are editable.
- Check types/Ctrl+Shift+M checks the unsaved buffer; markers and clickable
  diagnostics reflect that buffer. F12 navigates to an in-project definition.
  Checked buffers are closed after each query so an unsaved imported draft cannot
  contaminate an agent's later disk query. Input changes invalidate pending results.
- Migration 7 adds separate SQLite recovery copies, retaining the draft and its
  original revision. Writes coalesce after 250 ms and serialize per buffer; UI
  reports pending/completed/failed backup. Existing dirty buffers win over late
  recovery responses. Clean buffers refresh from disk. Session deletion cascades
  recovery rows and clears renderer buffers. Storage is limited to 100 dirty copies;
  reaching the limit preserves the current in-memory buffer with a visible error.
  Recovery copies do not save project files or send source to a model.
- Single-pane editing is implemented. Tabs/splits/layout persistence, completion,
  editor hover/reference UI, semantic rename/refactoring and automatic agent-change
  merging remain outstanding. Diagnostics apply to the requested file, not a full
  project check. Syntax registrations currently cover TS/JS, Python and Markdown;
  other text remains editable without newly promised language intelligence.

## Security and compatibility boundaries

Only a metadata request goes to Models.dev: no API keys, project files or chat
messages are included. HTTP credentials are omitted and redirects are rejected.
The source is community metadata; it does not prove native protocol compatibility,
account permissions or official retirement. Configured connection URLs remain under
user control. Cached model metadata contains no credentials.

Availability `available` means the configured adapter returned the model in a
successful discovery response, not a successful generation for that model.
`cataloged-unverified` allows an explicit attempt without claiming account access.
`confirmed-retired` is emitted only for retained native OpenAI shutdown-date evidence
after the dated UTC day ends. The API supplies no exact time or replacement ID;
the UTC-day convention is explicit, and replacements are chosen by the user.
Other authoritative provider retirement sources remain outstanding. Audio/structured capability
evidence is metadata, not a newly implemented audio/structured generation workflow.
Legacy adapter protocol heuristics still exist and require a broader compatibility
engine; unknown catalog evidence must not be presented as verified support.

Revision checks prevent interleaving writes from Graft's main process. The OS does
not provide compare-and-swap rename here, so a narrow race with an external process
between comparison and rename remains. Writer integration also has a narrow external
process race between revision checking and Git applying the patch. Private checkouts
isolate normal relative file/shell work; arbitrary Shell/MCP commands can still access
other host paths when the optional container sandbox is off. Worktree isolation is
not a universal OS sandbox. Live container behavior has not been verified here.

Language servers can read project configuration and imported dependencies. Trust
is not a filesystem sandbox for the TypeScript process. Recovery copies contain
plaintext source and original text in the same local SQLite database as sessions;
they are not credentials storage. A crash before backup acknowledgement can lose
the most recent typing. Closing/reloading flushes pending writes on a best-effort
basis; the completed backup status is the recovery guarantee for ordinary restart.
Deleted files' recovered buffers can be opened and copied; recreation/Save As is
not implemented. The lazy editor chunk is approximately 2.93 MB uncompressed;
startup does not load it until editing, but broad performance profiling remains.

The baseline npm audit reported 11 findings (8 moderate, 3 high). Adding Monaco
initially added two low findings. Targeted fixes pin DOMPurify 3.4.16,
http-cache-semantics 4.3.0 and image-size 2.0.4. Monaco embeds its own old sanitizer,
so the renderer resolver replaces that copy as well; built output was checked for
3.4.16 and absence of 3.4.15. Dev dependency prebundling excludes Monaco to preserve
that resolver. PptxGenJS's declared image parser is not called by its distributed
runtime; Graft uses its own bounded image-size reader, and document generation
tests pass with the override. No force downgrade of build/document packages was
made. The current audit has 8 moderate findings, all in the builder's
global-agent/roarr/sprintf-js chain; compatibility/remediation remains outstanding.

## Verification and external blockers

Windows x64, system Node 26.7.0/npm 11.19.0. CI targets Node 24.

| Check | Result |
| --- | --- |
| Baseline install | `npm ci` passed; native libraries loaded in tests. |
| Baseline typecheck/lint/build | Passed. Build has existing large-chunk/Zod annotation warnings. |
| Baseline unit suite | 63 files passed, 2 skipped; 864 tests passed, 28 skipped. |
| Implementation unit suite | 939 passed, 28 skipped (75 files passed, 2 skipped), including real LSP, durable editor recovery, migrations, model lifecycle and private writers. |
| Targeted fixes | Sites partial-request regression failed before the fix and passed after; provider/redaction fixtures passed. |
| Catalog Electron integration | Passed real main-process service, IPC, UI controls and restart persistence with only the HTTP transport replaced by a fixture. |
| Full Electron suite | 45 passed, 5 skipped (3.9m), including catalog/lifecycle, private writers, semantic intelligence, keyboard editor saves and recovery across app restart. Final versioned-build rerun pending. |
| Production build | Passed after the implementation. |
| Packaged Windows app | 0.6.14 x64 NSIS installer built; 2 packaged smoke tests passed, including SQLite/ripgrep/PTY, bundled LSP, Monaco saves, onboarding/session/settings and package contents. Installer ran successfully (exit 0) and the installed executable reports 0.6.14.0. Installed-app smoke verification pending. |
| Workflow YAML | CI and release files parse successfully. Hosted matrix execution outstanding. |
| Live source | Actual Models.dev response normalized successfully: 212 supported providers, 7,664 models at observation time. Counts change upstream. |

Hosted [CI run 37490772890](https://github.com/itzdexy/GraftCode/actions/runs/37490772890)
at the baseline commit failed before any job step ran. Its check annotation says:
“The job was not started because your account is locked due to a billing issue.”
That requires GitHub account administration; changing application code cannot clear
it. The user has now authorized committing/pushing the changes and running the
new Windows installer; the outcome is recorded below after execution.
macOS/Linux execution, signing/updater delivery, Docker-dependent tests
and real paid-provider account verification remain outstanding in this environment.

### Local 0.6.14 upgrade

The existing per-user installation was upgraded from 0.6.13 to 0.6.14 with the
NSIS installer. A consistent read-only SQLite backup was made before the upgrade,
under the ignored local `dist/upgrade-backup-0.6.13-20261009/` directory; it contains
private session data and must not be committed. Before upgrade: schema 4, 10
sessions, 3 providers. The installer preserves the existing user profile. Real
profile startup/migration verification is pending; no release tag or public
installer upload has been made.

## Research record and application

Reviewed primary/public documentation and source; public documentation is not proof
of private competitor internals.

| Source | Relevant pattern and decision |
| --- | --- |
| [Claude Code execution guide](https://code.claude.com/docs/en/how-claude-code-works) | Tool-use loops and context management. Preserve Graft's loop; extract/persist context state rather than replace it. |
| [Codex public source](https://github.com/openai/codex) | Public execution and sandbox architecture reference. Graft's optional container execution should not be described as universal isolation. |
| [OpenCode providers](https://opencode.ai/docs/providers/) and [models command source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/models.ts) | Models.dev and explicit metadata refresh. Add independent refresh with retained validated snapshots. |
| [Models.dev](https://models.dev) | Community model metadata; use as data, not an authority on account access/retirement. Tested its actual response, including experimental objects and nullable effort values. |
| [Cursor background agents](https://docs.cursor.com/background-agent) | Documented isolated background environments. Implement writer worktrees before expanding parallel mutation. |
| [VS Code LSP guide](https://code.visualstudio.com/api/language-extensions/language-server-extension-guide) | Protocol-based language intelligence is the next semantic-analysis foundation; regex symbols are not a substitute. |
| [Continue context selection](https://docs.continue.dev/ide-extensions/autocomplete/context-selection) and [autocomplete role](https://docs.continue.dev/customize/model-roles/autocomplete) | Use language-server definitions, imports and recent edits as explicit semantic context sources; keep future autocomplete/FIM model roles separate from chat routing. No autocomplete feature is claimed yet. |
| [OpenAI model list API](https://developers.openai.com/api/reference/resources/models/methods/list) | Documented shutdown-date evidence is preferable to guessing retirement from omission. Implemented native-endpoint validation, retained evidence and selection guards. |
| [Anthropic Models API](https://platform.claude.com/docs/en/api/http/models) | Confirmed Graft already reads native thinking/effort/image and token-limit metadata. Further server-tool/structured-output compatibility remains to be connected. |
| [Cline checkpoints](https://docs.cline.bot/core-workflows/checkpoints) and [Roo checkpoints](https://roocodeinc.github.io/Roo-Code/features/checkpoints/) | Preserve recoverable file/conversation state rather than destructive context pruning. Graft already has checkpoints and rewind. |

Official lifecycle evidence beyond native OpenAI and provider-specific generation
capability guarantees still need additional implementation and live account testing.

## Durable milestone checklist

### 1. Foundation and reliability — in progress

- [x] Audit the actual architecture and establish baseline quality gates.
- [x] Investigate the hosted CI failure and record its external cause.
- [x] Extract durable context state and catalog synchronization/validation services.
- [x] Improve credential handling, revision checks, retry timing and shutdown diagnostics.
- [x] Complete foundation desktop/packaged verification and record results.
- [ ] Continue decomposing session orchestration and define durable event/run consistency.

### 2. Automatic model management — implemented core, incomplete milestone

- [x] Live refresh, versioned snapshots, offline fallback and user-controlled cadence.
- [x] Provider metadata persistence, catalog capabilities and model availability UI.
- [x] Omission/outage/auth/deprecation recovery fixtures; real Electron refresh/restart flow.
- [x] Native OpenAI shutdown evidence, retained lifecycle state and explicit user replacement guidance.
- [ ] Other providers' official retirement evidence and model-specific replacement guidance.
- [ ] Comprehensive compatibility engine and live verification for supported provider accounts.

### 3. Agent execution improvements — started

- [x] Durable context state, safe revision checks and Retry-After handling.
- [x] Separate writing-agent worktrees, reviewable patches and destination-conflict retention.
- [x] Real parallel-writer/Task integration tests and persistent Agents-panel recovery details.
- [ ] Strong shell/MCP permission enforcement, durable execution replay and recovery/cleanup controls.
- [ ] Verify fallback behavior across native provider failures and durable run recovery.

### 4. Coding intelligence — implemented foundation, incomplete milestone

- [x] Real LSP framework, bounded TypeScript server lifecycle, semantic diagnostics/references and trust enforcement.
- [x] Semantic tool integration and editor draft checks/definition navigation.
- [ ] Incremental indexing, repository intelligence and semantic edits in real coding tasks.

### 5. Developer workspace — implemented editing foundation, incomplete milestone

- [x] Monaco single-pane editing, revision-checked saves and keyboard actions.
- [x] Persistent draft recovery with original revisions, app restart and deleted-file/conflict verification.
- [ ] Editable tabs/splits, integrated editor diffs and agent-aware updates.
- [ ] Persistent layouts and keyboard-driven open/edit/test workflows.

### 6. Research and advanced agents — pending

- [ ] PDF research with provenance, citation validation and research-to-code workflows.
- [ ] Best-of-N coding, enhanced routing and real model comparison lab.

### 7. Premium experience — pending

- [ ] UI refinement, custom themes, advanced preference-aware motion and accessibility checks.
- [ ] Expanded Scion/Buddy events, interactions and workspace customization.

### 8. Ecosystem and production hardening — pending

- [ ] Extensions, advanced MCP compatibility, observability and durable session replay.
- [x] Targeted sanitizer/image-parser/HTTP-cache advisory remediation, including Monaco's vendored copy.
- [ ] Remaining advisory remediation, cross-platform execution and measured performance.
- [ ] Release readiness, installer/signing/update verification and complete operational docs.

Next dependency-ordered work: expand provider lifecycle/compatibility and writer
recovery controls, then editor tabs/layouts/indexing and advanced-agent capabilities. Never check
off an exit criterion on a proposal alone.
