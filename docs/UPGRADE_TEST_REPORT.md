# Graft upgrade test report

## Initial checks

- `npm run typecheck`: passed before implementation changes.
- `npm run lint`: passed before implementation changes.
- First restricted `npm test`: no tests executed; Vite worker realpath calls
  were denied with EPERM. Retrying with the authorized unrestricted test runner.
- The previous verified 0.6.14 baseline had 939 unit tests and 45 desktop tests
  passing, with skipped cases recorded in `IMPLEMENTATION_STATUS.md`.

## Implementation validation so far

| Command / check | Actual result |
| --- | --- |
| New truncated-stream regression fixtures before changes | 5 failed, establishing the unsafe completion mechanism. |
| Partial-thinking recovery fixtures before changes | 2 failed; already-visible thinking disappeared on failed/cancelled streams. |
| `npx vitest run tests/unit/providers.test.ts tests/unit/agent.test.ts tests/unit/renderer/sessionsStore.test.ts` | 154 passed after changes. |
| Motion unit tests | 6 passed, including visibility timer disposal/resume. |
| Transcript projection / response quality / performance tests | 9 passed, including parity through rewind and live tool results. |
| Workspace layout and draft unit tests | 10 passed. |
| First full implementation unit run | 978 passed, 28 skipped; one LSP cleanup failure (Windows EPERM). |
| LSP shutdown regression | Real owned descendant remained alive after forced disposal before fix; active and evicted client regressions pass after fix. 8 LSP tests pass; cancellation/isolation repeated independently 3 times. |
| Final complete unit suite | 982 passed, 28 skipped; 79 files passed, 2 skipped. No cleanup retries weakened. |
| Scoped desktop confirmation | All 6 cases passed across scoped runs. New fixture assumptions and async clipboard checks corrected; original workspace coverage retained. |
| Final typecheck / lint | Passed, including node, renderer and E2E TypeScript. |
| Final complete desktop suite | 48 passed, 5 skipped (4.3 minutes). All original artifact/attachment/schedule and writer tests retained and passed. |
| Production build | Passed for 0.6.15. Known Monaco large-chunk warning remains. |
| Windows packaging | Completed; 0.6.15 NSIS installer and unpacked executable created. |
| Unpacked executable smoke tests | 2 passed: package contents and actual native tool/editor/LSP/terminal workflow. |
| Installation | NSIS exited 0; installed executable reports 0.6.15. |
| Installed executable smoke tests | 2 passed using isolated profiles; same native workflow and version verification. |
| Original profile preservation | Schema 7; 12 sessions and 3 providers; zero missing backed-up IDs; SQLite quick_check `ok`. |

The benchmark command uses `--disableConsoleIntercept` to capture real measurements:
500 turns, 120 live updates, full projection 38.37 ms versus cached projection
0.88 ms. This measures the production projection functions, not an app-wide speedup.

Protocol references: [OpenAI Chat streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)
and [Ollama API source](https://github.com/ollama/ollama/blob/main/docs/api.md).
No private provider endpoint generation quality or cross-platform result is claimed.

The default desktop skips are the two packaged cases (run separately against the
real executable) and three opt-in README screenshot cases. Unit skips include
opt-in live MCP/container integrations and platform-dependent fixtures. No skipped
case is reported as passed. macOS/Linux builds and live paid provider requests were
not run. The full master brief, universal shell/MCP isolation, indexing, best-of-N
and durable execution replay remain incomplete.

Installer: `dist/Graft-Setup-0.6.15.exe`, 123,782,941 bytes, unsigned.
SHA-256: `0D754F847CF6B437A8E7E42D04EAACF7FB65A75812346B726CF21A1F854ADC75`.
Unpacked app: `dist/win-unpacked/Graft.exe`. Installed app:
`%LOCALAPPDATA%/Programs/Graft/Graft.exe`. Private profile backup remains ignored
under `dist/upgrade-backup-0.6.14-20261009`; it must not be published.

This is a verified local Windows upgrade, not completion of the larger brief or
a signed, cross-platform public release. The previous GitHub CI run
`38001350984` could not start steps because account billing was locked.

The new [CI run 38003950510](https://github.com/itzdexy/GraftCode/actions/runs/38003950510)
for pushed commit `a28c0941d16fa4e233728c46b5eaa261cd03ca52` also failed before
any step started. Its Windows job annotation confirms: “The job was not started
because your account is locked due to a billing issue.” This is an unresolved
GitHub account blocker, not a passing CI result. Local unit, desktop and native
packaged/installed results above are the verification evidence.

## 0.6.16 round (2026-10-10)

Branch `feat/reliability-security-upgrade`, on top of `origin/main` at `5f586fc`.
The last commit that changes code or tests is `fc8d91f`; what follows it is
Markdown only. Two systems: Windows 11 (Node 26.7.0) and a clean
`node:24-bookworm` container (Node 24.21.0, Docker 29.8.0) packed from the working
tree. Nothing here ran on macOS, on GitHub's runners, or against a paid provider.

| Command | Where, commit | Result |
| --- | --- | --- |
| `npm run typecheck` | Windows, `fc8d91f` | exit 0 |
| `npx eslint . --max-warnings 0` | Windows, `fc8d91f` | exit 0 |
| `npx vitest run` | Windows, `fc8d91f` | 84 files passed, 2 skipped; 1055 tests passed, 29 skipped, 0 failed (14.3 s) |
| `npm run build` | Windows, `fc8d91f` | exit 0 |
| `npx playwright test` | Windows, `fc8d91f` | 51 passed, 5 skipped, 0 failed (4.0 min) |
| `GRAFT_DOCKER_TESTS=1 npx vitest run tests/unit/sandbox.docker.test.ts` | Windows with Docker, `fc8d91f` | 13 passed (real containers) |
| `npm run dist:win` | Windows, `fc8d91f` | exit 0, `dist/Graft-Setup-0.6.16.exe` |
| `npx playwright test tests/e2e/packaged.spec.ts` with `GRAFT_PACKAGED_EXE` | Windows, the unpacked 0.6.16 build | 2 passed (12.6 s) |
| `npm run typecheck`, `npx eslint . --max-warnings 0` | Linux container, `fc8d91f` | exit 0, exit 0 |
| `npx vitest run`, three times | Linux container, `fc8d91f` | each time 84 files passed, 2 skipped; 1047 tests passed, 37 skipped, 0 failed |
| `npm run build`, `xvfb-run -a npx playwright test` | Linux container, `85eeacc` | exit 0; 51 passed, 5 skipped, 0 failed (4.0 min) |
| `npm audit` | Windows | 8 moderate, all one advisory with no fixed version (see the roadmap) |

`fc8d91f` differs from `85eeacc` in the runtime lookup's path rules (the same on a
Linux host as before), one unit test file and one unit-test fixture, so the Linux
desktop suite was not repeated for it.

What failed on the way, and where it came from:

| Check | Where | Result | Cause |
| --- | --- | --- | --- |
| `npx playwright test`, branch at `8a0b752` | Linux container | 48 passed, 2 failed, 5 skipped | Both also fail on `origin/main` (next row). |
| `catalog.spec.ts` and `editor.spec.ts` on `origin/main` `5f586fc` | Linux container | 3 passed, 2 failed | `editor.spec.ts:12`: a real fault, the save dropped (fixed in `f943cc8`). `catalog.spec.ts:53`: the test stored a key without the opt-in a system with no keyring needs (`f489c08`). |
| The same two files five times each, branch | Linux container | 25 passed, 0 failed | |
| `npx vitest run`, branch at `85eeacc` | Linux container | 4 failed, 1043 passed, 37 skipped | Also on `origin/main`: tests and a lookup that assumed a Windows host, and a fixture racing the MCP SDK (`fc8d91f`). |
| Shell tests against the kill logic before this branch | Linux container | the test for a child that ignores SIGTERM fails | Fixed in `b7781e7`. |
| Permission probe with `security.ts` from before this branch | Linux container | a localhost page in the thumbnail session and in a new one is granted `location` and `notifications` | Fixed in `70af743`; the probe now reads `denied` for both. |
| The Bash wrapper from before #3, real Git Bash | Windows | the orphaned loop kept writing after the timeout (75 to 105 bytes) | Fixed on `main` by #3; this branch makes its test run on Windows. |

Skipped, and never counted as passed:

- Desktop, 5: two packaged-app cases (run separately above: 2 passed) and three
  opt-in README screenshot cases (not run).
- Unit on Windows, 29: 14 in `mcp.live.test.ts` (opt-in, starts real MCP servers; not
  run), 13 in `sandbox.docker.test.ts` (opt-in; run separately above: 13 passed), the
  sandbox's planted-link case and the SIGKILL case, which need POSIX (both pass in the
  Linux container).
- Unit on Linux, 37: the same 27 opt-in cases and 10 that need Windows.

Measured, not estimated: `out/main/index.js` is 1,094.43 kB against 1,075.55 kB on
`origin/main` (+1.8%); the renderer's entry chunk 999.08 kB against 994.82 kB (+0.4%);
the Monaco chunk is unchanged at 2,930.11 kB. No start-up time, memory or frame-rate
measurement was taken, and no speed-up is claimed.

Installer: `dist/Graft-Setup-0.6.16.exe`, 123,791,199 bytes, SHA-256
`db996e3efb400f240f3b5c5201dc9b79048d72dbc5cf0e8baecf44794e7d1ab4`.
`Get-AuthenticodeSignature` reports `NotSigned` for it and for `Graft.exe`
(electron-builder prints its signtool step with no certificate set). It was not
installed: the 0.6.15 already on this computer and its profile were left alone, so the
step from schema 7 to 8 is covered by `tests/unit/usageDays.test.ts` and
`tests/unit/contextState.test.ts` only, not by a real profile. No release was
published and no tag was made. GitHub Actions did not run (the account's billing
lock); the changed workflows were parsed and their new step run by hand.

## 0.6.17 round (2026-10-10)

Branch `feat/claude-like-session-view`, local only: nothing of it was pushed, and no
package was built. It sits on `origin/main` at `5f586fc` and contains
`feat/reliability-security-upgrade` (0.6.16, `b51155e`), merged at `9e2e771`. The last
commit that changes the app or its tests is `c38a213` (Settings search); before it
come the symbol search (`38605bb`), a merge of `origin/main` that changes no file
(`613421d`) and the container script (`5ce005f`). What follows it is Markdown only. Two
systems: Windows 11 (Node 26.7.0) and a clean `node:24-bookworm` container
(Docker 29.8.0) packed from the working tree. Nothing here ran on macOS, on GitHub's
runners, or against a paid provider.

| Command | Where, commit | Result |
| --- | --- | --- |
| `npm run typecheck` | Windows, `38605bb` | exit 0 |
| `npx eslint . --max-warnings 0` | Windows, `38605bb` | exit 0 |
| `npx vitest run` | Windows, `38605bb` | 88 files passed, 2 skipped; 1116 tests passed, 29 skipped, 0 failed |
| `npm run build` | Windows, `38605bb` | exit 0 |
| `npx playwright test` | Windows, `38605bb` | 51 passed, 5 skipped, 0 failed (4.1 min) |
| `npx playwright test tests/e2e/editor.spec.ts -g "Monaco edits" --repeat-each=8` | Windows, `9e2e771` | 8 passed |
| `npm run typecheck`, `npx eslint . --max-warnings 0` | Linux container, `9e2e771` and `38605bb` | exit 0, exit 0, both times |
| `npx vitest run` | Linux container, `9e2e771` | 88 files passed, 2 skipped; 1106 tests passed, 37 skipped, 0 failed |
| `npm run build`, `xvfb-run -a npx playwright test` | Linux container, `9e2e771` | exit 0; 51 passed, 5 skipped, 0 failed (4.1 min) |
| `npx vitest run` | Linux container, `38605bb` | 88 files passed, 2 skipped; 1108 tests passed, 37 skipped, 0 failed |
| `xvfb-run -a npx playwright test tests/e2e/semantic.spec.ts tests/e2e/editor.spec.ts` | Linux container, `38605bb` | 4 passed |
| `npm run verify:docker` | Linux container, `613421d` with the script's own change | typecheck, lint and build exit 0; 88 files passed, 2 skipped; 1108 tests passed, 37 skipped, 0 failed; desktop suite 51 passed, 5 skipped, 0 failed (4.0 min) |
| `npm run typecheck`, `npx eslint . --max-warnings 0`, `npm run build` | Windows, `c38a213` | exit 0, exit 0, exit 0 |
| `npx vitest run` | Windows, `c38a213` | 90 files passed, 2 skipped; 1123 tests passed, 29 skipped, 0 failed |
| `npx playwright test` | Windows, `c38a213` | 52 passed, 5 skipped, 0 failed (4.1 min) |
| `npm run verify:docker` | Linux container, `c38a213` | typecheck, lint and build exit 0; 90 files passed, 2 skipped; 1115 tests passed, 37 skipped, 0 failed; desktop suite 52 passed, 5 skipped, 0 failed (4.1 min) |

`npm run verify:docker` is new in this round (`scripts/e2e-docker.mjs --all`): one
container runs every step whatever the one before it did and writes each step's log
and a line of exit codes to `test-results/docker/`. The rows for `c38a213` are the
final tree: complete on both systems.

What failed on the way, and where it came from:

| Check | Where | Result | Cause |
| --- | --- | --- | --- |
| `npx playwright test`, branch at `0d2b2a1` (before the merge) | Windows | 47 passed, 1 failed, 5 skipped | `editor.spec.ts:12`, the save dropped right behind typing. The same test alone: 8 of 14 runs failed on the branch, 3 of 8 on its first commit `9488408`, 2 of 11 on a clean `origin/main`. So the fault is older than the branch and shows on Windows too, not only on Linux; whether the branch made it likelier or the computer was busier was not settled. Fixed by `f943cc8`, which the merge brought in: 8 of 8 afterwards. |
| `npx vitest run` after the merge | Windows | `tests/unit/db.test.ts`: 1 failed | The test pins the whole `behavior` section, to which each round had added a default. Both are expected now. |
| `npx vitest run`, eight full runs | Windows | 2 runs with 1 failure each | `languageServers.test.ts`: `EPERM` removing a test's folder while the language server that had just been ended still held it; `removeDir` retries longer now, and five further runs did not show it again. `computer.test.ts`: the real mouse pointer moved one pixel between a move and a read; not changed. |
| Real-server test with the re-sync of open documents switched off | Windows | fails: 0 problems reported for a file whose import had changed on disk | It is what the fix is for (`refresh` in `languages/servers.ts`). |
| `docker desktop start` | Windows | the engine took about nine minutes to answer the first time, twelve seconds the second | `wsl -l -v` hung meanwhile. Nothing was changed on the system; it was stopped again afterwards. |

Skipped, and never counted as passed: the same cases as in the 0.6.16 round (desktop 5;
unit 29 on Windows and 37 on Linux), for the same reasons. The opt-in suites
(`mcp.live.test.ts`, `sandbox.docker.test.ts`, the packaged-app cases and the README
screenshots) were not run in this round, and no installer was built or installed.

Checked by hand in the renderer preview (scripted sessions, not a real provider): a
diff with a made-up key covers it and the eye uncovers it; an approval for an edit
shows the whole path and the change as it is; Verbose opens and folds rows already on
screen; a session returns to where it was left, and to its latest message when that
place is gone; the line of a block at work shows the turn's time and the context size;
Settings lists its pages under headings, a search finds a setting with its page, and
Enter opens the page with the setting in view and marked.
Not checked by hand: the running-tasks link on that line (the preview has no background
commands) and the Changes panel's eye.

Measured, not estimated: `out/main/index.js` is 1,107.35 kB against 1,094.43 kB at
0.6.16 (+1.2%); the renderer's entry chunk 1,024.55 kB against 999.08 kB (+2.5%); the
Monaco chunk is unchanged at 2,930.11 kB. No start-up time, memory or frame-rate
measurement was taken, and no speed-up is claimed. The first check of an edit after a
language server starts was not timed on a large project.

## 0.6.22 round (2026-10-11)

Branch `feat/durable-agent-and-isolation`, on top of `origin/main` at `84a2269`
(0.6.16). The last commit that changes code or tests is `7bf76e2`; what follows it is
Markdown only. Two systems: Windows 11 (Node 26.7.0) and a clean `node:24-bookworm`
container (Node 24.21.0, Docker 29.8.0) packed from the working tree. Nothing here
ran on macOS, on GitHub's runners, or against a paid provider.

| Command | Where, commit | Result |
| --- | --- | --- |
| `npm run typecheck` | Windows, `7bf76e2` | exit 0 |
| `npx eslint . --max-warnings 0` | Windows, `7bf76e2` | exit 0 |
| `npx vitest run` | Windows, `7bf76e2` | 87 files passed, 2 skipped; 1125 tests passed, 29 skipped, 0 failed |
| `npm run build` | Windows, `7bf76e2` | exit 0 |
| `npx playwright test` | Windows, `7bf76e2` | 53 passed, 5 skipped, 0 failed (4.3 min) |
| `GRAFT_DOCKER_TESTS=1 npx vitest run tests/unit/sandbox.docker.test.ts` | Windows with Docker, `7bf76e2` | 13 passed (real containers) |
| `npm run dist:win` | Windows, `7bf76e2` | exit 0, `dist/Graft-Setup-0.6.22.exe` |
| `npx playwright test tests/e2e/packaged.spec.ts` with `GRAFT_PACKAGED_EXE` | Windows, the unpacked 0.6.22 build | 2 passed (10.8 s) |
| `npm run typecheck`, `npx eslint . --max-warnings 0` | Linux container, `7bf76e2` | exit 0, exit 0 |
| `npx vitest run`, twice | Linux container, `7bf76e2` | each time 87 files passed, 2 skipped; 1117 tests passed, 37 skipped, 0 failed |
| `npm run build`, `xvfb-run -a npx playwright test` | Linux container, `7bf76e2` | exit 0; 53 passed, 5 skipped, 0 failed (4.2 min) |

What each fix was seen to fail on first:

| Fix | Before | After |
| --- | --- | --- |
| The tool journal (`70cd28b`) | A turn that failed after a search had returned told the model "Not run: the turn was interrupted" (`expected 'Not run…' to contain 'kept.ts'`). With the journal switched off, `tests/e2e/recovery.spec.ts` finds no note after the app is killed. | The search's result is in the next request; the note is on screen when the session is opened, and the model is sent "Outcome unknown". |
| Stop for a tool that ignores it (`70cd28b`) | The turn ended 10,003 ms after Stop, when the tool's own limit ran out. | Under 3 s, with the tool reported as possibly still finishing. |
| A damaged reply (`e21cf48`) | A call whose arguments lost a piece ran as `rm -rf ./build`. | Neither call of that reply runs; the model asks again and `rm -rf ./build/cache` runs. |
| Quitting in stages (`25cdca7`) | One `try` around every part (by reading; no test existed). | Four tests: a failing and a stuck stage are left behind and the later ones run. |
| What a server inherits (`a08acd3`) | A server process had every variable of the app's environment. | A real server set to leave keys out does not have `GRAFT_TEST_API_KEY` and has the variable its settings give it. |

One unit test failed once in a full run and passed when repeated, alone and in the next
two full runs: `computer.test.ts`, "starts and round-trips the pointer position". It
reads the live pointer twice a second and a half apart and expects it not to have moved;
the pointer had moved one pixel. The computer was in use. It is not a result of this
round and was not changed.

Skipped, and never counted as passed:

- Desktop, 5: two packaged-app cases (run separately above: 2 passed) and three
  opt-in README screenshot cases (not run).
- Unit on Windows, 29: 14 in `mcp.live.test.ts` (opt-in, starts real MCP servers; not
  run), 13 in `sandbox.docker.test.ts` (opt-in; run separately above: 13 passed), the
  sandbox's planted-link case and the SIGKILL case, which need POSIX (both pass in the
  Linux container).
- Unit on Linux, 37: the same 27 opt-in cases and 10 that need Windows.

Measured, with the conditions:

- Startup and quit, `npm run measure:startup`, 7 runs of each kind, Windows 11, Ryzen 7
  9800X3D, 32 GB, medians in milliseconds, Playwright attached (so for comparing builds,
  not for quoting):

  | | window | interface | quit |
  | --- | --- | --- | --- |
  | `origin/main`, new profile | 317 | 460 | 97 |
  | this branch, new profile | 313 | 456 | 109 |
  | `origin/main`, second start | 312 | 449 | 87 |
  | this branch, second start | 307 | 448 | 96 |

- The tool journal: 2,000 calls written, ended and forgotten against a database file,
  102 microseconds per call with a 200-character result and 279 with a 50,000-character
  one.
- The `Symbols` tool on this repository (583 tracked files), medians of five: outline
  1 ms, definition 45 ms, references 46 to 47 ms, importers 50 to 52 ms, tests 69 ms.
  "impact", added in this round: 132 ms for a file that reaches 5 others, 278 ms for
  30, 821 ms for the most widely imported file (139 files, 5 steps).
- `out/main/index.js` is 1,120.28 kB against 1,094.43 kB on `origin/main` (+2.4%); the
  renderer's entry chunk 1,000.96 kB against 999.08 kB (+0.2%).

No memory or frame-rate measurement was taken.

Installer: `dist/Graft-Setup-0.6.22.exe`, 123,799,146 bytes, SHA-256
`3945a18de76bf0c736cf0ffc461a6f7221e40f95ce50ef110333a9e7ce737d72`.
`Get-AuthenticodeSignature` reports `NotSigned` for it and for `Graft.exe`. It was not
installed: the Graft already on this computer and its profile were left alone, so the
step from schema 8 to 9 is covered by `tests/unit/journal.test.ts` and
`tests/unit/contextState.test.ts`, not by a real profile. No release was published and
no tag was made.

## 0.6.23 build (2026-10-11)

Branch `feat/richer-graft`, local only: nothing of it was pushed and no release was made.
It holds three rounds in one tree: `feat/claude-like-session-view` (0.6.17, `728bc7c`), the
diagrams round (`d962aee` to `2be9cef`, then `0657bf9`) and `origin/main` at `2097f7e`
(0.6.22), merged at `aeb7155`. The installer was built from `f61ff60`; `214f306` after it
adds one test of the package, and what follows that is a test step and Markdown. Two
systems: Windows 11 (Node 26.7.0) and a clean `node:24-bookworm` container (Docker 29.8.0)
packed from the working tree. Nothing here ran on macOS, on GitHub's runners, or against
a paid provider.

| Command | Where, commit | Result |
| --- | --- | --- |
| `npm run typecheck` | Windows, `f61ff60` | exit 0 |
| `npx eslint . --max-warnings 0` | Windows, `f61ff60` | exit 0 |
| `npx vitest run` | Windows, `f61ff60` | 99 files passed, 2 skipped; 1234 tests passed, 29 skipped, 0 failed |
| `npm run build` | Windows, `f61ff60` | exit 0 |
| `npx playwright test` | Windows, `f61ff60` | 57 passed, 5 skipped, 0 failed (5.0 min) |
| `npm run dist:win` | Windows, `f61ff60` | exit 0, `dist/Graft-Setup-0.6.23.exe`, 127,740,749 bytes, SHA-256 `47d9ca59fa43198fef61246d81a6768337a73e4406f66847623adbc50a0951e7`, not signed |
| `npx playwright test tests/e2e/packaged.spec.ts` with `GRAFT_PACKAGED_EXE` | Windows, the unpacked 0.6.23 build, tests at `214f306` | 3 passed (12.5 s) |
| `npm run verify:docker` | Linux container, `214f306` | typecheck, lint and build exit 0; 99 files passed, 2 skipped; 1226 tests passed, 37 skipped, 0 failed; desktop suite 57 passed, 6 skipped, 0 failed (4.6 min) |
| `npx playwright test tests/e2e/diagrams.spec.ts` | Windows, `214f306` with the clipboard step | 3 passed (17.5 s) |

The Windows desktop run was made on the tree that became `f61ff60` while two of that
commit's Markdown files were still being written; the app and the tests were as committed.
The clipboard step (Copy image puts a PNG on the clipboard) was added to the diagram test
after the container run and has run on Windows only.

What the tests of this round show, and with what:

- A code session writes a diagram and the turn ends with its card: the page in a frame
  with `sandbox="allow-scripts"`, the bundled fonts loaded (`Instrument Serif`, `Geist
  Mono`), no sideways scroll, at most 520 px high. Save as PNG gives 1920 by 1200 for a
  960 by 600 diagram; Save as SVG gives a file that starts with the `svg` element and
  carries the page's styles; Copy image puts a PNG on the clipboard; the viewer opens,
  zooms and goes back to Fit; a diagram whose file is gone says so before any dialog.
- A chat is offered `Skill` and told how to use it, reads `SKILL.md` and the template
  without being asked anything, saves the page with `CreateFile`, lists it with its files
  and draws it; a copy is offered in Downloads.
- The packaged app has `resources/skills/diagram-design` and `resources/fonts`, tells a
  session about the skill, draws a diagram with those fonts and makes its PNG.
- Every diagram here is the skill's own template with one rectangle, written by a scripted
  provider. No model drew anything.

What failed on the way, and where it came from:

| Check | Where | Result | Cause |
| --- | --- | --- | --- |
| `git merge origin/main` into the branch | Windows | 12 files in conflict | Both sides had added lines in the same places: the version (two files), imports in `sessionHost.ts`, settings passed in `sessionManager.ts`, a default in `appSettings.ts`, the session harness, `db.test.ts`, the release notes and four documents. Both sides were kept, and the build numbered 0.6.23. |
| `npm run typecheck` after the merge | Windows | 1 error in `tests/e2e/diagrams.spec.ts` | `[...document.fonts]`: a `FontFaceSet` is not iterable with the library the desktop tests are compiled for. Written with `forEach`. |
| `npx vitest run` after the merge | Windows | `settingsIndex.test.ts`: the file snapshot differed | 0.6.22 added three settings rows the snapshot of 0.6.17 did not have. Regenerated with `-u` and read. |
| `npm run typecheck` with the new tool | Windows | `skillTool.ts`: `timeoutMs` missing | Every tool has a time limit; this one has 30 seconds. |
| `npx vitest run`, first full run at `0657bf9` | Windows | 1 failed, 1233 passed | `computer.test.ts`, "starts and round-trips the pointer position": the real pointer moved one pixel (`342 64` to `342 65`) between a move and a read. The computer was in use. It passed alone (9 of 9) and in the next full run, and was not changed. |

Skipped, and never counted as passed:

- Desktop on Windows, 5 in the full run: the two packaged-app cases there were then (all
  three were run separately above: 3 passed) and three opt-in README screenshot cases (not
  run). In the container, 6: the three packaged cases and the three screenshot cases.
- Unit on Windows, 29: 14 in `mcp.live.test.ts` and 13 in `sandbox.docker.test.ts` (both
  opt-in, not run in this round), and two that need POSIX (both pass in the container).
- Unit on Linux, 37: the same 27 opt-in cases and 10 that need Windows.

Not verified:

- That a model follows the skill. Nothing here used a real provider, so what a given
  model draws, and whether a small or local one manages at all, is not known from this.
- The skill's own Python scripts: not run.
- The installer: built, not run, and nothing was installed. The tests start
  `dist/win-unpacked/Graft.exe` with a temporary profile. An update from an installed
  copy was not tried. The copy installed on this computer is 0.6.17, whose database is
  schema 8; this build's is 9 (the tool journal of 0.6.22), so the first start after
  installing it changes `%APPDATA%\Graft\graft.db`, and 0.6.17 will not open that file
  afterwards.
- By hand: nothing in this round was looked at by a person in the running app. The two
  screenshots the tests take (`test-results/shots/diagram-card.png`,
  `packaged-diagram.png`) were looked at: the card, the serif title and the saved-picture
  notice are there.

Measured, not estimated: `out/main/index.js` is 1,154.35 kB against 1,120.28 kB at 0.6.22
(+3.0%) and 1,107.35 kB at 0.6.17 (+4.2%); the renderer's entry chunk is 1,040.17 kB
against 1,000.96 kB (+3.9%) and 1,024.55 kB (+1.5%); the Monaco chunk is unchanged at
2,930.11 kB. The package gains the skill (5.6 MB on disk) and four font files (120 KB);
the installer is 127,740,749 bytes against 126,515,528 for the 0.6.17 one built on this
computer (+1.0%). No start-up time, memory or frame-rate measurement was taken, and no
speed-up is claimed.

From 13:12 local time another session began editing the same folder (uncommitted changes
to the session view). Every run above had finished by then, or used a build made before
it; none of those changes is in a commit named here or in the installer.

## 0.6.24 round (2026-10-11)

Branch `feat/richer-graft`, local only: nothing was pushed and no release was made. One
commit, `d0ce442`, on top of the 0.6.23 build. Two systems: Windows 11 (Node 26.7.0) and a
clean `node:24-bookworm` container (Docker 29.8.0) packed from the working tree. Nothing
here ran on macOS, on GitHub's runners, or against a paid provider.

| Command | Where, commit | Result |
| --- | --- | --- |
| `npm run typecheck` | Windows, tree of `d0ce442` | exit 0 |
| `npm run lint` | Windows, tree of `d0ce442` | exit 0 |
| `npm test` | Windows, tree of `d0ce442` | 101 files passed, 2 skipped; 1246 tests passed, 29 skipped, 0 failed |
| `npm run test:e2e` (build, then the desktop suite) | Windows, tree of `d0ce442` | 57 passed, 6 skipped, 0 failed (4.6 min) |
| `npm run dist:win` | Windows, `c5ac340` | exit 0, `dist/Graft-Setup-0.6.24.exe`, 127,745,592 bytes, SHA-256 `a09fac8a20a5604f31fcd21cf0135e0460a5114ce66c43e5d7af16ffdbfabd1e`; its signature was not checked this round |
| `npx playwright test tests/e2e/packaged.spec.ts` with `GRAFT_PACKAGED_EXE` | Windows, the unpacked 0.6.24 build of `c5ac340` | 3 passed (23.3 s) |
| `npm run verify:docker` | Linux container, `d0ce442` | typecheck, lint, unit and build exit 0; desktop suite 57 passed, 6 skipped, 0 failed (4.7 min) |

`c5ac340` follows `d0ce442` with one change to a stylesheet (a quoted block in a chat lost
its coloured edge) and one line of the roadmap. The installer was rebuilt from it; the
suites above it in the table ran on `d0ce442` and were not run again.

The six skipped desktop tests are the three of the packaged app (run separately, above) and
the three that take README screenshots.

What the tests of this round show, and with what:

- Unit, 12 new cases in two files. The walk on the grid stays on the grid for 3,000 steps,
  moves one cell at a time, reaches its dot and never turns back onto itself. A complete
  SVG becomes an image address with the namespace added; an unfinished one, a page that
  only contains one, another language and an oversized one stay code. A block that is
  searching counts each found page once. A call is "being made" only between its start
  and its result. `og:image` is read from the head only, Open Graph before the Twitter
  card, https only, at most 2,000 characters, and stays with its page in the sources.
- By hand, in the renderer preview with scripted turns (no model, no network): the grid
  appears for a running `GenerateImage` and its dots move; the finished card is 440 px
  wide with the reveal animation on its picture; the viewer opens, steps to 150% and
  closes; an SVG block streams as code and becomes the drawing, with the toggle; the live
  line read "Searching 5 websites", then 11; the Sources card showed two page pictures
  and one site icon; with Motion set to Reduced the grid held still and the picture showed
  at once.

Not verified:

- No picture was generated by a real image model, and no page's picture was fetched from
  the web: `pagePicture` (the main-process fetch and re-encoding) has no test and was not
  run. It uses the same request code as site icons, which is tested only for which hosts
  it accepts.
- The page-picture path has no desktop test: the suite's pages are served from this
  computer over http, and only https pictures are taken.
- The viewer loading the file itself in a code session was not exercised; the preview
  showed the stored 512 px picture.

## 0.6.25 round (2026-10-12)

Branch `feat/richer-graft`, local only: nothing was pushed and no release was made. Six
commits, `6313f83` to `b7dbb41`, on top of the 0.6.24 build. Two systems: Windows 11 (Node
26.7.0) and a clean `node:24-bookworm` container (Docker 29.8.0) packed from a separate
checkout of `b7dbb41`. Nothing here ran on macOS, on GitHub's runners, or against a paid
provider.

| Command | Where, commit | Result |
| --- | --- | --- |
| `npm run typecheck` | Windows, `b7dbb41` | exit 0 |
| `npm run lint` | Windows, `b7dbb41` | exit 0 |
| `npm test` | Windows, tree of `b7dbb41` (see below) | 107 files passed, 2 skipped; 1286 tests passed, 29 skipped, 0 failed |
| `npm run build` | Windows, tree of `b7dbb41` (see below) | exit 0; two warnings from the CSS optimizer, which does not know `::highlight()` |
| `npx playwright test` | Windows, tree of `b7dbb41` (see below) | 60 passed, 6 skipped, 0 failed (4.9 min) |
| `npm run dist:win` | Windows, `b7dbb41` | exit 0, `dist/Graft-Setup-0.6.25.exe`, 128,584,310 bytes, SHA-256 `4e8c3a7d86938c734deaba713d11f8bec693e162d601a446aa102963c85ee7f0`; its signature was not checked this round |
| `npx playwright test tests/e2e/packaged.spec.ts` with `GRAFT_PACKAGED_EXE` | Windows, the unpacked 0.6.25 build of `b7dbb41`, the spec as of `10a835a` | 3 passed (12.9 s) |
| `npm run verify:docker` | Linux container, `b7dbb41` | typecheck, lint, unit and build exit 0; unit 1278 passed, 37 skipped; desktop suite 60 passed, 6 skipped, 0 failed (4.9 min) |

The first Windows run of the five failed its type check and its lint, both in the new
desktop test: `tsconfig.e2e.json` did not list `DOM.Iterable`, which the highlight
registry's `has()` and `size` need. One line was added to that file and the two commands
were run again, exit 0. The unit tests, the build and the desktop suite are the ones of
that first run, on the tree without that line; it changes what is type-checked, not what
runs. An earlier full unit run, before the equations task, had one failure:
`languageServers.test.ts` could not remove its temporary folder (`EPERM`). The file passed
alone right after and in the two full runs that followed.

The six skipped desktop tests are the three of the packaged app (run separately, above) and
the three that take README screenshots. The unit tests skipped on Linux only are the ones
that need a Windows host.

What the tests of this round show, and with what:

- Unit, 40 new cases in seven files. A request to open a file or to type a line reaches
  the panel once and is counted. The first changed line of a patch. Which code spans are
  file names (`src/app.ts:42`, a Windows path, `Dockerfile`) and which are not (`0.6.18`,
  `health()`, an address). Names are asked about 200 at a time after 50 ms, once each, by
  session, and a batch that fails answers "no file". `FileIndex.resolve` on real folders:
  the path as written, an absolute path inside, the one file that ends with it, nothing for
  two such files or a path that leads out, and a file made after the list was read. What a
  fence says about its block; folding; which blocks are a command for the terminal, with
  none for a block that holds a carriage return, a tab, an escape or a line break.
  Finding text across the pieces a word is drawn in and never across two blocks, beside a
  letter whose lower case is longer, with the limit of 1,000. Math in each of the four
  ways it is written, and money, shell variables, code, escaped brackets and unfinished
  math left alone.
- Desktop, 3 new tests in `conversation.spec.ts`, with a scripted reply (no model). The
  names of files that exist once are links and open the editor at line 14; a name two
  files share and one no file has stay code. `$5 and $10` stays text beside one set
  formula. A block of 45 lines names its file, shows 20, unfolds and wraps. A command is
  typed into the terminal, is seen there not run, and Enter runs it. Find counts 7
  matches, steps round, marks without adding an element and leaves no mark behind;
  Escape returns the keyboard to the message box. A Mermaid block sends `/diagram`. The
  editor keeps its own Ctrl+F. Escape in the find bar leaves a running turn running.
- Packaged app: a reply with a formula sets it, so the math chunk, its stylesheet and
  fonts load from the package; a file the reply names is a link.
- By eye, three of the four screenshots the desktop test takes
  (`test-results/shots/conversation-*.png`): the reply, the file at its line, the find bar.

Not verified:

- No model wrote any of the replies: what a real model names, fences and writes as math
  was not seen. One formula was set in a test; the range of LaTeX that KaTeX takes, a
  formula that fails, and math in a chat were not exercised.
- File links on a large project (the file list holds up to 200,000 names) and find on a
  long conversation were not measured.
- Nothing of this round was run with motion reduced. The desktop tests ran with motion on
  (this PC does not ask for less of it: `prefers-reduced-motion` was false in the test
  app), and none of them checks an animation. The only new one is the find bar's entrance,
  which uses the shared utility that reduced motion switches off.
- The installer was built and its unpacked app tested; the installer itself was not run.

## 0.6.26 round (2026-10-12)

Branch `feat/richer-graft`, local only: nothing was pushed and no release was made. Seven
commits on top of the 0.6.25 round, `832caa1` to `7523d86`, after `10a835a`, which gave the
packaged test a formula and a file link. Two systems: Windows 11 (Node 26.7.0) and a clean
`node:24-bookworm` container (Docker 29.8.0) packed from a separate checkout of `7523d86`.
Nothing here ran on macOS, on GitHub's runners, or against a paid provider.

| Command | Where, commit | Result |
| --- | --- | --- |
| `npm run typecheck` | Windows, `7523d86` | exit 0 |
| `npm run lint` | Windows, `7523d86` | exit 0 |
| `npm test` | Windows, `7523d86` | 111 files passed, 2 skipped; 1319 tests passed, 29 skipped, 0 failed |
| `npm run build` | Windows, `7523d86` | exit 0 |
| `npx playwright test` | Windows, `7523d86` | 64 passed, 6 skipped, 0 failed (5.4 min) |
| `npm run verify:docker` | Linux container, `7523d86` | typecheck, lint, unit and build exit 0; unit 1311 passed, 37 skipped; desktop suite 64 passed, 6 skipped, 0 failed (5.3 min) |

No installer was built for 0.6.26 by itself. The 0.6.27 build, made the same day from the
commits that follow, carries it.

The six skipped desktop tests are the three of the packaged app and the three that take
README screenshots.

What the tests of this round show, and with what:

- Unit, 33 new cases in five files. A comment as the agent reads it: its place, the line
  in backticks, a removed line marked, line breaks turned into spaces. Comments after a
  message by file and line; alone under a line of their own; left waiting by a `/` or `!`
  command. What is kept (100 a session, 50 sessions) and nothing for stored text that does
  not fit. Where a comment sits in a diff, and which lines an editor's selection covers.
  The palette's three modes, a line after a file's name, the file that names a project,
  and an answer to an older query dropped. `changedProblems` against a stand-in server:
  errors and warnings in order, a file that is slow or fails named with the reason, a
  question that ran out of time called off, nothing asked in a project that is not
  trusted or has no packages, 50 files at most.
- Desktop, 4 new tests in `review.spec.ts`. A comment written on a line of the diff in the
  Changes panel, edited, left waiting by `/cost`, kept in the window's storage, sent after
  the next message with its place and its line, and gone afterwards. A comment from the
  editor with Ctrl+Alt+M and one on a removed line under an edit in the conversation; the
  list above the message box, one comment deleted, the rest sent with nothing typed.
  Ctrl+P finds a file loosely, opens it, opens another at a line, says when nothing
  matches, and turns into the command and the symbol palette. Ctrl+T finds a function
  through the real language server and opens it at its line. Problems lists a real type
  error of a file the agent wrote, opens it at the problem, writes the request to fix it
  into the message box and sends nothing; in a project that is not trusted both say so.

Not verified:

- No model wrote a reply here or read a comment: the requests were read from a stand-in
  provider. Whether a model acts well on "Comments on the code:" was not tried.
- Problems and Go to symbol ran on fixture projects of one and two files. The limits of 50
  files and 60 seconds were met with a stand-in server only, never a slow real one.
- A comment on several selected lines, and comments when the window's storage is full or
  missing, are covered by unit tests of the model and not by a run of the app.

## 0.6.27 round (2026-10-12)

Branch `feat/richer-graft`, local only: nothing was pushed and no release was made. Eight
commits of this round, `a49bd66` to `110490c` (`16566bf` among them is the report of
0.6.26), and one test commit after them, `3c63364`. Two systems: Windows 11 (Node 26.7.0) and a clean `node:24-bookworm` container
(Docker 29.8.0) packed from a separate checkout. Nothing here ran on macOS, on GitHub's
runners, or against a paid provider.

| Command | Where, commit | Result |
| --- | --- | --- |
| `npm run typecheck` | Windows, `110490c` | exit 0 |
| `npm run lint` | Windows, `110490c` | exit 0 |
| `npm test` | Windows, `110490c` | 114 files passed, 2 skipped; 1340 tests passed, 29 skipped, 0 failed |
| `npm run build` | Windows, `110490c` | exit 0 |
| `npx playwright test` | Windows, `110490c` | 68 passed, 6 skipped, 0 failed (6.0 min) |
| `npm run dist:win` | Windows, `110490c` | exit 0, `dist/Graft-Setup-0.6.27.exe`, 128,593,538 bytes, SHA-256 `3b4151b9eaed5c0b2dc368cebae9775206d9e0e5518550488473a93c8c1c02c4`; its signature was not checked this round |
| `npx playwright test tests/e2e/packaged.spec.ts` with `GRAFT_PACKAGED_EXE` | Windows, the unpacked 0.6.27 build of `110490c` | 3 passed (13.9 s) |
| `npm run verify:docker` | Linux container, `110490c` | typecheck, lint, unit and build exit 0; unit 1332 passed, 37 skipped; desktop suite 68 passed, 6 skipped, 0 failed (5.9 min) |
| `npx playwright test tests/e2e/panels.spec.ts` | Windows, `3c63364` | the browser test with its new check: 1 passed |
| `node scripts/e2e-docker.mjs tests/e2e/panels.spec.ts` | Linux container, `3c63364` | the four panel tests, the browser one with its new check among them: 4 passed (21.6 s) |

`3c63364` adds one check to one desktop test and changes no code of the app; the installer
and the full runs are those of `110490c`.

What the suite found on the way, each fixed before the runs above:

- A full Windows run of the commit before, `0393063`, had one failure of 68: at 900 by 600
  the strip under the editor was out of view. The wrapper that lets the panel column slide
  let the column grow to the height of what it held. Fixed in `110490c`.
- With Settings as a window, a menu opened inside it was drawn behind it: menus and
  popovers lay under dialogs. Found by the settings test that opens a provider's menu.
- While the panel column slid, 4 px of it reached past the page (the layout test), first
  through the margin kept for its resize handle, then through the handle itself.
- Pressed in the same frame in which a search opened over Settings, Escape closed Settings
  and left the search open. Found by a test that presses it that fast.

Desktop tests that were changed, and why. No assertion was removed from any of them.

- `settings.spec.ts`, `motion.spec.ts`, `layout.spec.ts`: each clicked the sidebar, the
  account menu or the mode switch with Settings open. Settings is a window over the page
  now, so they close it first. The helper that opens a settings page finds the window by
  its attributes: found by role, it is hidden for a moment while another dialog closes
  over it. `layout.spec.ts` also checks the window's frame at every size.
- `settings.spec.ts`: Escape after opening the search is pressed until the search is gone.
- `panels.spec.ts`: a folder in the file tree was found by its exact name, which gains a
  mark once git has answered; the slide of the column gave git the time. It is found by
  the start of its name.

The six skipped desktop tests are the three of the packaged app (run separately, above) and
the three that take README screenshots.

What the tests of this round show, and with what:

- Unit, 21 new cases in four files. A change of view fades only when nothing speaks
  against it; it is made once and at once where there is no page; with a browser that
  runs the change a frame later, a second change makes the first one first and neither
  twice; none fades with motion reduced or the window hidden. The page Settings lies
  over, closing it with the history as it was, stepping back through its sections, and a
  removed session under it. Rows that changed place and how far, none for more than 600
  px or more than 30 at once. Tasks that changed since the list before, by id, by place
  and by their words, and never across two turns.
- Desktop, 4 new tests in `windows.spec.ts`. The Settings window at 900 by 600: at most
  1,000 by 720, 32 px clear on every side, the session still under it, the keyboard on
  the window and no tooltip open, Escape left to a shortcut that is being recorded, then
  closing; Forward opens it again and a click beside it closes it. A change of page and of
  theme starts a view transition with motion on, and none with motion reduced, where the
  duration is zero. The panels stay in their column for at least 150 ms while it slides
  shut, and are gone within 50 ms with motion reduced. A task that finished carries the
  mark with its animation in a list that arrived while the turn ran, and the mark without
  an animation after a restart.
- The browser panel's page sits exactly on its place after the page loads, and again
  after the panel is closed and opened with the page there. With the handling of the
  slide switched off for one run, it ended 19 px beside its place and the test failed.

Not verified:

- How any of the motion looks. The tests read computed styles, counts and timings; the
  screenshots are of settled states. Nobody watched a cross-fade, the slide or a row
  travel, and no recording was made.
- A row travelling in the sidebar: the arithmetic is unit-tested and the rows carry their
  keys, but no run moved a row and looked for its animation.
- A cross-fade with a long conversation on screen (the browser takes a picture of the
  window for it) was not timed.
- The installer was built and its unpacked app tested; the installer itself was not run.

## 0.6.28 round (2026-10-12)

Branch `feat/richer-graft`, local only: nothing was pushed and no release was made. Six
commits: `2fd86fb`, `7b2b3c2`, `db774f5` and `e68c1ab` (the round), `fbf2a59` (the version)
and `3c56f6a` (one desktop test). Two systems: Windows 11 (Node 26.7.0) and a clean
`node:24-bookworm` container (Docker 29.8.0) packed from a separate checkout. Nothing here
ran on macOS, on GitHub's runners, or against a paid provider.

| Command | Where, commit | Result |
| --- | --- | --- |
| `npm run typecheck` | Windows, `fbf2a59` | exit 0 |
| `npm run lint` | Windows, `fbf2a59` | exit 0 |
| `npm test` | Windows, `fbf2a59` | 9 full runs: 6 passed (117 files passed, 2 skipped; 1367 tests passed, 29 skipped) and 3 had one failure each, always in `tests/unit/languageServers.test.ts` (below) |
| `npm run build` | Windows, `fbf2a59` | exit 0 |
| `npx playwright test` | Windows, `fbf2a59` | 69 passed, 6 skipped, 1 failed (6.7 min): the Settings search test, which `3c56f6a` corrects |
| `npx playwright test tests/e2e/settings.spec.ts -g "found by searching"` | Windows, `3c56f6a` | 1 passed |
| `npm run verify:docker` | Linux container, `3c56f6a` | typecheck, lint, unit and build exit 0; unit 1359 passed, 37 skipped; desktop suite 70 passed, 6 skipped, 0 failed (6.6 min) |
| `npm run dist:win` | Windows, `3c56f6a` | exit 0, `dist/Graft-Setup-0.6.28.exe`, 128,707,206 bytes, SHA-256 `4126ba372f9ed664450a35f300be3be9e63900e5042e11668812de471c3e8643`; its signature was not checked this round |
| `npx playwright test tests/e2e/packaged.spec.ts` with `GRAFT_PACKAGED_EXE` | Windows, the unpacked 0.6.28 build of `3c56f6a` | 3 passed (19.0 s) |

`3c56f6a` changes one desktop test and no code of the app. The full Windows desktop run is
that of `fbf2a59`; on Windows only the corrected test was run again at `3c56f6a`. The full
Linux run and the installer are those of `3c56f6a`.

A failure that is not this round's, and is not fixed. Three of nine full runs of the unit
suite on Windows failed with one test each, in the block "real TypeScript language-server
queries" of `languageServers.test.ts` (two different tests of it), every time with
`EPERM, Permission denied` while the test removed its temporary folder. That file alone
passed three times of three. The same measurement on the untouched 0.6.27 commit `a60a6a4`,
in a separate checkout: one of six full runs failed the same way. Docker Desktop was
starting or running during all of these. So it was there before this round; whether the
round or the load made it more frequent, nine and six runs cannot say. The Linux run had no
such failure. A task to find its cause was noted for the owner.

What the suite found on the way:

- The full Windows run failed in `settings.spec.ts`: a search for "motion" finds two rows
  since the new setting, and the test clicked whichever began with "Motion". The test now
  expects both and takes the one that is the word (`3c56f6a`).
- Typecheck: the renderer's store has a switch over every event, which had no case for the
  new `aside` event. A test that reads the stylesheet from disk does not typecheck among
  the renderer's tests (they are checked without Node's types): it is `motionTokens.test.ts`
  among the others.
- Lint: a comment between two `case` labels counts as a fall-through.
- A built stylesheet writes `380ms` as `.38s`: the desktop test reads the panel's computed
  animation time instead of the token's text.
- The preview harness, which is not part of the app: its scripted agents had no `writes`
  list, which the app fills in when it parses an event, so the Agents panel failed there.

Desktop tests that were changed, and why. Where a number changed, the old one is still
asserted for the Calm style.

- `motion.spec.ts`: with Motion on, the home screen had to have arrived within 350 ms. That
  is still asserted for Calm; for Lively, the default, it is 550 ms (380 ms and delays up to
  150 ms). Reduced is nothing for both.
- `windows.spec.ts`: a change of page took 150 ms. Now: Lively is 300 ms, the window is
  marked for exactly the change of page and not for a change of theme, and the page then
  has a frame of its own; Calm is 150 ms with no frame; with motion reduced every lively
  time and the Settings window's own animation are zero. The panel test also checks that a
  panel joining another comes in with the lively animation in 380 ms.
- `settings.spec.ts`: as above.

The six skipped desktop tests are the three of the packaged app (run separately, above) and
the three that take README screenshots.

What the tests of this round show, and with what:

- Unit, 27 new cases in five files. A side question is asked with the conversation as text,
  the question last, no tools, no web search, the lowest effort and the session's privacy;
  its answer is handed on piece by piece; an empty conversation says so; a long one keeps
  its opening and its newest part; an empty answer and a refused request fail with their
  reason. In a session: answered while a turn runs and the turn ends as it would have,
  nothing of it stored; answered with no turn running and none started; cancelled by its id and by closing the session; an empty question refused; as an
  ordinary message it is explained and no request is made. In the window: asking, hearing,
  the answer, a failure that keeps what was heard, dismissing with and without a request to
  cancel, three kept and the fourth pushing the oldest out, each session its own. Motion:
  the window is marked only while a change of page takes, never when the change is made at
  once; an older profile gets the lively style and an unknown style is refused; the
  stylesheet's lively block comes before the blocks that zero the times, and every lively
  animation takes its time from a token (two of these were also seen failing against a
  stylesheet broken on purpose).
- Desktop, 2 new tests in `aside.spec.ts`. A side question typed in the middle of a held
  turn: the card shows the question and the answer and that it is kept out, the turn's Stop
  button is still there, nothing is queued, the transcript has neither; the request had
  system and user only, no tools, the earlier message and the question in it; the next
  message's request has neither question nor answer; dismissing removes the card; `/btw`
  alone keeps the text and says what is missing; three requests were made in all. The
  command menu lists `/btw` with its description.
- Looked at, in the renderer preview (the app's interface in a browser, with scripted
  turns): the card asking, answering, answered and failed; the animations a change of page
  starts (`graft-page-in`, 300 ms, on the page's own frame; `graft-page-out`, 110 ms) and
  the mark coming and going. Three recordings of that preview were made for a film (a task
  with a side question, a group of agents, moving about and Settings), and frames of them
  were looked at: a page mid-way into place, the card arriving, the panel coming in, the
  Settings window, the Motion style row.

Not verified:

- No model answered a side question: the provider is scripted in the tests and in the
  preview. Nothing shows how good an answer is, or how long one takes on a long conversation.
- How the lively motion feels in the installed app. The tests read computed styles, marks
  and timings; the recordings are of the preview in a headless browser, and what was looked
  at were frames of them, not the motion playing. Nobody has used it for a day.
- The browser's panel staying put is a rule in the stylesheet; the existing test that its
  page is on its place passed, but no test opens it beside another panel in the lively style.
- A side question's request is not counted in the usage of a session or a day (as titles
  are not), and no test says so.
- The installer was built and its unpacked app tested; the installer itself was not run.

## 0.6.29 round (2026-10-12)

Branch `feat/richer-graft`, local only: nothing was pushed and no release was made. Five
commits: `22bd3a0`, `d2a62d8` and `79b7476` (the round), `4db1fa8` (the version) and `16ea25c`
(a fix to the site watcher, found on review). Two systems: Windows 11 (Node 26.7.0, npm
11.19) and a clean `node:24-bookworm` container (Docker 29.8.0) packed from a separate
checkout. Nothing here ran on macOS, on GitHub's runners, or against a paid provider.

| Command | Where, commit | Result |
| --- | --- | --- |
| `npm run typecheck` | Windows, `16ea25c` | exit 0 |
| `npm run lint` | Windows, `16ea25c` | exit 0 |
| `npm test` | Windows, `16ea25c` | two full runs: one passed (119 files passed, 3 skipped; 1383 tests passed, 30 skipped); one had two failures, both the `EPERM` in `languageServers.test.ts` that the 0.6.28 report describes |
| `npm run build` | Windows, `16ea25c` | exit 0 |
| `npx playwright test` | Windows, `4db1fa8` | 70 passed, 6 skipped, 1 failed (7.3 min): `conversation.spec.ts:56` |
| `npx playwright test` | Windows, `16ea25c`, first run | 70 passed, 6 skipped, 1 failed (9.1 min): `writers.spec.ts:54` |
| `npx playwright test` | Windows, `16ea25c`, second run | 71 passed, 6 skipped, 0 failed (7.2 min) |
| each of the two failed tests alone, `--repeat-each=3` | Windows | 3 passed, and 3 passed |
| `npm run verify:docker` | Linux container, `16ea25c` | typecheck, lint, unit and build exit 0; unit 1375 passed, 38 skipped; desktop suite 71 passed, 6 skipped, 0 failed (6.8 min) |
| `GRAFT_LIVE_SITE=1 npx vitest run tests/unit/sites.live.test.ts` | Windows, `16ea25c`, with the network | 1 passed (9.4 s with npm's cache warm; 19 s on its first run, before the last commit) |
| `npm run dist:win` | Windows, `16ea25c` | exit 0, `dist/Graft-Setup-0.6.29.exe`, 128,710,313 bytes, SHA-256 `209951eb94f59bf6dd9729b038f4fea8b214b42f65c75e8b46a51b922d2b571c`; its signature was not checked this round |
| `npx playwright test tests/e2e/packaged.spec.ts` with `GRAFT_PACKAGED_EXE` | Windows, the unpacked 0.6.29 build of `16ea25c` | 3 passed (20.0 s) |

Two of the three full desktop runs on Windows had one failure each, and they have to be
read with what else the computer was doing. During the first, unit tests, a type check and
lint of this same project were run beside it, which was a mistake. During the second
nothing of this project ran, but Roblox Studio and the Roblox player were open on the
computer and held between a quarter and a third of its processor when measured. The two
failures were different tests, neither in code this round touches (text reaching the
terminal within 15 s; an agent's failure showing in the Agents panel within 30 s); each
passed three times of three alone, both passed in the third full run, and both pass in
the container. That is evidence of load, not proof that there is no fault in either test.

What the round found on the way:

- The watcher of a site asked what the site is built with for every file that changed,
  which reads the site's record from disk, and an install changes thousands of files. It
  is settled once per watch now (`16ea25c`). Under such a burst Windows also reports
  changes without a name (a probe: 80 new files gave one named change and one unnamed).
  An unnamed change counts as a build only if the built page is no longer what it was.
  Both were written as a failing test first.
- An `npm install` started from inside another npm's script fails here with
  `EALLOWSCRIPTS`: it inherits the outer npm's settings. The live test runs npm without
  them, as a shell of the user's would. `npx remotion add` failed the same way earlier in
  the day, in another folder.
- npm's newest TypeScript is 7.0; the starter stays on 5.9.3, the compiler of Graft's own
  language server.
- Two faults of the tests themselves, fixed before the runs above: a match that minded a
  capital letter, and a mark looked for inside the picture's button instead of the site's
  row.

Desktop tests that were changed, and why. `sites.spec.ts`: the test of a plain site now
chooses Plain HTML first, since a new site starts as a project where npm is found, and
checks the card's mark; nothing else of it changed. One test is new.

The six skipped desktop tests are the three of the packaged app (run separately, above) and
the three that take README screenshots. The unit suite skips one more test than before: the
live one, which needs npm and the network and runs when asked.

What the tests of this round show, and with what:

- Unit, 16 new cases in two files. The starter: its twelve files, exact versions, a build
  that type-checks first, strict settings, relative addresses, the site's name as text
  whatever is in it, the type check found as the project's check, nothing written over. A
  site's stack in its record, plain for a record without one, kept when the record changes.
  Serving a built site: the page that says it is being set up before a build; after one,
  the built page and what it links, and 404 for `package.json`, the sources, the packages
  and the `dist` address itself; an address with no file gets the page and a missing file
  gets 404, while a plain site has only the pages it has; one reload for a build of several
  files, none for a change to a source, a package or `package.json`; the kind asked for
  once per watch; a burst of 80 files in `node_modules` is no change, and a build in the
  middle of a second burst is one. The brief for each stack. What a new site starts as,
  with and without npm, and what the page says about it.
- The starter for real, on Windows with the network: `npm install` (23 packages),
  `npm run typecheck`, `npm run build`; the built page has relative addresses and holds the
  site's name; Graft's server serves the page, its script and its stylesheet as what they
  are and hides `package.json`; a type error (`TS2322`) fails the build and leaves the built
  page as it was. In a folder with a space and brackets in its name. The packages take
  67 MB.
- Desktop, 1 new test and 1 changed. A TypeScript site through the app: the choice starts
  on React + TypeScript and says that Graft asks before it installs or builds; the folder
  holds the project with the site's name in it before the model has written a line; the
  model's first request carries the brief for a project and not the plain one; the page
  Graft serves is the one in `dist`, with `package.json` and the sources answering 404 and
  an address without a file getting the page; the card says TypeScript; the choice is
  still there afterwards.
- Looked at, in the renderer preview: the Sites page with the choice, the line under it,
  two cards with their marks, and the state without npm (the project greyed, plain chosen,
  the line naming Node.js).

Not verified:

- No model built a TypeScript site. In the desktop test the model is scripted and writes
  the build's output itself, since packages cannot be installed there. Whether a model
  follows the brief (components, typed data, no `any`), and how the session goes through
  the prompts for `npm install` and `npm run build`, was not watched once.
- The starter was installed and built on Windows with Node 26.7 only: not in the
  container, not on macOS, not with an older Node.
- An edit to a site being checked by the language server after the install: the versions
  are the same by choice, and no test opens a site's file to see a problem reported.
- The installer was built and its unpacked app tested; the installer itself was not run.

## 0.6.30 round (2026-10-13)

Branch `feat/richer-graft`, local only: nothing was pushed and no release was made. Eight
commits: `8ea1df3` and `9a519fb` (text search), `ec5c2e9`, `344d2e8` and `67f11f4` (the page
check, the three sizes, a picked element's picture), `a9912b9` (the version), `bca01b7` (three
faults a review of the round found) and `1fc322b` (a fault of 0.6.27 that the second full run
showed). One system: Windows 11 (Node 26.7.0, npm 11.19, Electron 44.5.1). The request said
to run the build for Windows only, so nothing here ran in the Linux container, and no Linux
package was built; nor did anything run on macOS, on GitHub's runners, or against a paid
provider.

The whole of it was run three times, with `npm run verify` (new this round: the five steps
one after another, each into its own log under `out/verify`).

| Command | Commit | Result |
| --- | --- | --- |
| `npm run typecheck` | `a9912b9`, `bca01b7`, `1fc322b` | exit 0, each time |
| `npm run lint` | the same three | exit 0, each time |
| `npm run build` | the same three | exit 0, each time |
| `npm test` | `a9912b9` | passed: 124 files passed, 3 skipped; 1468 tests passed, 30 skipped |
| `npm test` | `bca01b7` | exit 0 |
| `npm test` | `1fc322b`, three full runs | one passed (124 files; 1471 tests passed, 30 skipped); two had one failure each, both the `EPERM` in `languageServers.test.ts` that the 0.6.28 report describes, in two different tests of that file |
| `npx vitest run tests/unit/languageServers.test.ts`, three times | `1fc322b` | 13 passed, each time |
| `npx playwright test` | `a9912b9` | 77 passed, 6 skipped, 0 failed (17.9 min) |
| `npx playwright test` | `bca01b7` | 75 passed, 6 skipped, 2 failed (15.7 min): `session.spec.ts:33`, `settings.spec.ts:67` |
| `session.spec.ts:33` alone, `--repeat-each=3` | `bca01b7` | 3 passed |
| `settings.spec.ts:67` alone | `bca01b7` | 3 failed of 3, then 1 of 2; on `a9912b9` in a separate checkout, 2 passed of 2 |
| `settings.spec.ts:67` alone, `--repeat-each=4` | `1fc322b` | 4 passed |
| `npx playwright test` | `1fc322b` | 77 passed, 6 skipped, 0 failed (8.9 min) |
| `npm run dist:win` | `1fc322b` | exit 0, `dist/Graft-Setup-0.6.30.exe`, 128,735,786 bytes, SHA-256 `909aad2556bcf8c4ad880de10020f04eeafca88a1b4f417cbe09ad129b356084`; `Get-AuthenticodeSignature` says NotSigned |
| `npx playwright test tests/e2e/packaged.spec.ts` with `GRAFT_PACKAGED_EXE` | the unpacked 0.6.30 build of `1fc322b` | 3 passed (22.4 s) |

The computer was in use the whole time. A game and Blender were running: the processor
stood at 69% when measured between the second and third runs, and the first two desktop
runs took twice as long as the third (in the second, single tests took 15 to 30 s that
take 5 to 7 s). That is what the two failures of the second run have to be read against,
and they turned out to be two different things.

`session.spec.ts:33` (the status bar's line counts after an edit, within 15 s) passed three
times of three alone and in both other full runs. That is evidence of load, not proof that
there is no fault in it.

`settings.spec.ts:67` was a fault of the app, and the load only showed it. The test said
"Escape empties the box and leaves Settings open". Probed in the app, 26 times of 26:
Escape in the Settings search, with text in the box, emptied the box and closed Settings.
It has done so since Settings became a window (0.6.27). The dialog layer listens for
Escape while the event travels down, before anything inside the window hears it, so the
box could not keep the key by stopping it. The test had passed since then by looking
during the window's closing animation: right after the key the window was still in the
page with its box emptied, and 600 ms later it was gone. A slow computer looked after it
had gone. The test now asks the window whether it is open (it failed 2 of 2 that way
before the fix), and covers Escape on something that was found and Escape with the box
empty. That the test passed on `a9912b9` and failed on `bca01b7`, alone and three times,
first read as "the last commit broke it"; the next two runs on `bca01b7` gave one pass
and one failure, and nothing that commit touches is on that path.

What the round found on the way:

- A page view that is not in the window is not drawn (Electron 44.5.1, measured in a
  script outside Graft): `capturePage` of one failed with `UnknownVizError` or did not come
  back, and a capture through the DevTools protocol did not come back, seven attempts of
  seven. A view in the window but placed outside its area (left of it, below it, right of
  it) gave 7 pictures of 21, and a capture that did not come back seemed to disturb the
  next ones. A view inside the window is drawn even at one pixel: 36 pictures of 36 came
  back at 390, 768 and 1280 px. So the agent's screenshot of a page whose panel was shut,
  or covered by a dialog, could not have worked before this round; that was not tried in
  a 0.6.29 build.
- ripgrep's JSON answer ignores `--max-columns` and counts in bytes: a line arrives whole,
  whatever its length, and "héllo" in a line with an "ï" before it starts at byte 16 and
  character 15.
- A rule written as "smaller than 24 × 24 px" named every unstyled button (21 px tall).
  The guideline's test is the room around a small target; the rule was rewritten to that
  before it was first run on a page.
- Three faults of the round's own code, found reading it over while the first full run
  was going, each then written as a failing test: the Search tab took the keyboard
  whenever it was shown again; the number on the check button outlived its page; a page
  could make a selector of any length and it travelled into the agent's tool result.
- Faults of the tests themselves, fixed before the runs above: a count guessed instead
  of counted (4 problems and 5 warnings, not 7 and 4), selectors written without their
  `body >`, a step looked for by its own words while the transcript folds a turn's browser
  steps into one line, and the message box looked for by the name it has before a
  session's first turn.

Desktop tests that were changed, and why. `settings.spec.ts`: the end of the search test,
as above. `browser.spec.ts`: one test is new; nothing else of it changed.

The six skipped desktop tests are the three of the packaged app (run separately, above) and
the three that take README screenshots. The unit suite skips what it skipped before.

What the tests of this round show, and with what:

- Unit, 88 new cases (1383 before, 1471 now). Text search: what ripgrep is asked for each
  option, with the text never read as an option; a line shown without indentation and cut
  around its first match; bytes counted as characters; a line and a path that are not
  valid text; and against real files: lines by file in the order of their paths, `.git`
  and what git ignores left out (also in a folder that is not a repository), case, whole
  words, a pattern, globs, nothing found, the limit of 2,000 lines, a pattern that cannot
  be read, and being stopped. The Search tab's words, its marks, the results as text with
  a key covered, and its state: the answer of the search asked last is the one kept, an
  emptied box drops a late answer, each session to itself, the keyboard handed over once.
  The page check's rules, each from facts and without a page: contrast at the guideline's
  line (#767676 passes on white, #777777 does not), see-through text and layered
  backgrounds, one finding for a pair of colours, large and bold text, text over a picture
  not judged, pictures, names, a placeholder as the only name, small targets with and
  without room, headings, a page wider than its window, the order and the limit of the
  list, a selector too long to be one, and the check as the agent reads it. The Browser
  tool's `check` and `width` against a stand-in for the panel; Plan mode allows both. The
  briefs. Which pictures a message box takes of those sent to it.
- Desktop, 6 new tests and 1 changed. Search through the app: the key, typing, what git
  ignores, the marks, case, globs, the arrow keys, Enter opening the editor with the
  cursor at the match (typed text lands before the word), the tab as it was left, the
  keyboard not taken on coming back to the session, the results as a file in the message
  box; a pattern that cannot be read. The page check through the app, on a page served
  for the test with one of each flaw: the scripted agent checks it at 1280 and at 390 and
  is sent back exactly the planted findings (and the sideways scroll at 390 only), and the
  page is in the panel at the panel's width afterwards; three pictures of 390 × 844,
  768 × 1024 and 1280 × 800 from a panel under 400 px wide, and again with the page taken
  out of the window; the drawer's headline, findings, count, the box drawn in the page, the
  request written into the message box and not sent, the count gone after a reload. A
  picked element: its picture is the size of the button with a few pixels around it, the
  click picked and did not press, and a model that cannot read pictures is not told off.
- The packaged app, looked at once with a test written for it and then removed: version
  0.6.30, `app.isPackaged` true; the Search tab found "3 lines in 2 files"; the drawer
  read "2 problems, 1 warning at 388 px wide"; the three pictures had their sizes.
- Looked at, in screenshots of the app under test: the Search tab with results, and the
  page check's drawer. The page itself is a native view and is not in those pictures.

Not verified:

- Linux and macOS, at all. The search runs ripgrep with paths in the other system's
  form, and the page check attaches to a view through the DevTools protocol: both are
  the kind of thing that differs by system.
- No model used the check. In the desktop test the model is scripted. Whether a model
  runs `check` when the brief asks, and what it does with the findings, was not watched.
- The check on real sites. It was run on one page made for the test and one small page
  in the packaged app. How often it leaves a text unjudged on a page with pictures, and
  whether its targets and names agree with a full audit tool, was not measured.
- The look of a page while it is laid out at another width (it shows in the panel for a
  moment), and the three sizes on a display that is not at 100% scale.
- The installer was built and its unpacked app tested; the installer itself was not run.
- The installer was built from `1fc322b`. The commit after it holds this report, the
  status entry, and one comment in `browserPanel.ts` made to say what was measured
  (see the first point of what was found); nothing that runs changed.

## 0.6.31 round (2026-10-15)

Branch `feat/richer-graft`, local at the time of writing: nothing had been pushed and no
release was made. Three commits: `8d32a6d` (limits for a session, a project and a day,
and what a model is offered as its own class), `6782a33` (the replace request from the
Search tab) and `af87761` (the version, what's new, the README, the roadmap and the guide
to trying it). One system: Windows 11 (Node 26.7.0, npm 11.19.0, Electron 44.5.1).
Nothing ran in the Linux container, on macOS, on GitHub's runners, or against a paid
provider. No package was built and nothing was installed.

The whole of it was run twice with `npm run verify` (typecheck, lint, the unit suite, the
build, the desktop suite one after another, each into its own log under `out/verify`):
once on the working tree before the release commits, once at `af87761`.

| Command | Commit | Result |
| --- | --- | --- |
| `npm run verify` | working tree before `8d32a6d` | exit 0; typecheck 4 s, lint 24 s, unit 16 s, build 10 s, e2e 451 s |
| `npm run verify` | `af87761` | exit 0; typecheck 5 s, lint 36 s, unit 17 s, build 12 s, e2e 458 s; unit 125 files passed, 3 skipped (1503 tests passed, 30 skipped); desktop 77 passed, 6 skipped |

What the tests of this round show, and with what:

- Unit, 32 new cases (1471 before, 1503 now). The limits that hold
  (`turnBudget.test.ts`, `agent.test.ts`): each scope's tokens and cost, the totals a
  turn starts from, a tool's own spending, the order the limits are checked in (the
  session's, then the project's, then the day's), the unpriced-model notice said once and
  naming only the limits that are set, and no limit unless Settings sets one. Through the
  session: a pause that holds across turns (continuing is a new turn, and it pauses again
  without asking the model anything), the project's total read from another session's
  saved usage, the day's from its rows. The store (`db.test.ts`): a project's total sums
  its sessions' saved totals and only those, counts a null price as nothing and an
  unknown folder as zero; an install from before the six settings loads with all six at
  "no limit". The offering (`offering.test.ts`, 9 cases): each gated tool offered exactly
  when its condition holds, web access from the session, the setting and the engine, a
  chat's tools and what it may make, media never in incognito, a big MCP setup waiting for
  ToolSearch and a small one not, each session's MCP tools keyed by its project root. The
  replace request (`searchModel.test.ts`, `textSearchStore.test.ts`): the message names
  the search, the replacement and what was found; how the search looked travels with it; a
  replacement with quotes stays as typed; a stopped search is never written as complete;
  the replacement is kept per session and is not part of the query.
- Desktop: the search test, extended. The replace request is composed in the app: the
  first press opens the replacement box and focuses it, the second writes into the message
  box — `Replace every match of "total" (case matched, in *.md) with "grand total". The
  search found 1 line in 1 file.` — and nothing is sent.

Desktop tests that were changed, and why. `search.spec.ts`: the block above. Its first
draft looked for the composer by the home screen's words ("Describe a task or ask a
question") while inside a session, where the box names itself "Ask anything · / commands ·
@ files · ! shell"; the fault was in the test, and it now matches the session's box.

The six skipped desktop tests are the three of the packaged app and the three that take
README screenshots. The first three were not run this round: no package was built.

Found on the way, and fixed: the install-from-an-older-version test failed on the six new
settings until it knew them (an old profile loads with all six at "no limit"); the
settings index was regenerated for the new rows; four call sites in `turnBudget.test.ts`
needed the new `project` field of a spend start, which typecheck caught before any suite
ran.

What the pauses say, for whoever tests them by hand: `Paused after about 2,100 tokens in
this session, past the limit of 2,000 for one session set in Settings → Permissions.` —
with `this project` or `today` in the same place for the other two scopes, and
`Paused at about $0.60 for this session, … The amount comes from published prices and can
differ from your bill.` for cost. The model with no published price is named once:
`The cost limit for a session can't follow Fake Model: it has no published price. Its
requests are counted in tokens only.` (the sentence names whichever cost limits are set).

Not verified:

- Linux and macOS, at all. The project's total is a SQL join over the sessions table and
  the settings go through the same schema on every system; neither was run elsewhere.
- A real model against a limit. Every pause and notice here is scripted; whether a person
  finds the numbers believable at a real provider's cache pricing was not watched.
- The project's total against a long-lived database with many sessions, worktrees and
  deleted sessions.
- The six new rows walked in the Settings UI beyond the smallest token choice; the
  desktop suite does not visit them.
- The push to GitHub and the pull request: this report was written before them.

## 0.6.32 round (2026-10-17)

Branch `feat/from-the-recordings`, cut from `origin/main` at `d50d997` (0.6.31) in its own
worktree, local: nothing was pushed and no release was made. Commits `225e31c` (the details
column, the folded queue, the effort note), `a78e51a` (pictures from tools), `926b644` (3D
models), `f9db56e` (their desktop tests), `be19aa7` (code colors), `b27290d` (terminal and
diff options), `145567f` (what the first full desktop run found), `b322e9a` (the version and
the documents) and `bdf48fd` (what is packed). Windows 11 (Node 26.7.0, npm 11.19.0, Electron
44.5.1) and a Linux container (`node:24-bookworm`). Not macOS: see the end.

| Command | Commit | Result |
| --- | --- | --- |
| `npm test` | working tree after `f9db56e` | 130 files passed, 3 skipped; 1536 passed, 30 skipped |
| `npx playwright test tests/e2e/recordings.spec.ts` | working tree after `f9db56e` | 3 passed (WebGL drew the model on this computer) |
| `npm run verify` | working tree before `b322e9a` | typecheck, lint, build exit 0; unit exit 1 (below); e2e exit 1: 77 passed, 3 failed, 6 skipped, 502 s |
| `npx playwright test` of `diagrams`, `session`, `recordings`, `layout` | after `145567f` | 15 passed |
| `npx vitest run tests/unit/computer.test.ts` | `145567f` | 9 passed |
| `npm run verify` | `b322e9a` | stopped by me before its desktop suite, when the user asked for the builds at once |
| `npm run dist:win`, then `packaged.spec.ts` against `dist/win-unpacked` | `b322e9a` | the package was broken: 1 passed, 2 failed (below) |
| `npm run dist:win`, then `packaged.spec.ts` | `bdf48fd` | installer built; 3 passed |
| `npm run dist:linux:docker` (build and `packaged` smoke test in the container) | `b322e9a` | AppImage and .deb built; 3 passed |

The unit failure of the full run was `computer.test.ts` "starts and round-trips the pointer
position": the test moves the real pointer and read it back one pixel off (`190 281` for
`191 281`) while this computer was in use. Alone it passed. It touches nothing of this round.

The three desktop failures of the full run were this round's, and are fixed in `145567f`:

- `diagrams.spec.ts`: "Save as…" was never still enough to press. With the details column the
  conversation is narrower, the diagram card sat at the window's height, and the scrollbar came
  and went; the column widened and narrowed and the scaled diagram with it, for ever. The
  conversation now keeps its scrollbar's place (`scrollbar-gutter: stable`).
- `session.spec.ts` "an edit turn … status bar" looked for the git bar's change count, which the
  column replaces while it is shown. The column's Changes card now shows the same labelled
  chip; the test's comment says where the count is.
- `session.spec.ts` "the session menu opens Files …" found two regions named Changes: the panel
  and the column's card. The column's cards are groups now, not landmarks.

The broken package: `files: ['out/**']` packed everything under `out/`, and the first Windows
build's own log was being written to `out/` while the archive was made. Its header and its bytes
disagreed, so every file after the log was read at the wrong place, and the packaged app quit as
it started (its `package.json` read as the end of a test log). The user had installed it by then;
their data folder was not touched, since the app quit before opening it. `bdf48fd` packs only
`out/main`, `out/preload` and `out/renderer`, and the rebuilt installer passed the three
packaged tests. The Linux packages were built from `b322e9a` in a container from `git archive`,
where `out/` holds only the build, so the same fault could not reach them; they were not built
again from `bdf48fd`.

What the tests of this round show, and with what:

- Unit, 52 new cases. The column (`detailsModel.test.ts`): when it is drawn (wanted, no panel,
  room for 420 pixels of conversation), the context's parts scaled to the session's count with
  the free space and the distance to compaction, connectors' rows in Customize's words with the
  one action each needs, the outputs a session's tools made and nothing they only edited, the
  background tasks with what runs first, elapsed times. Kept states (`keptStates.test.ts`): the
  column's toggle and folded cards, the effort notes put away, the terminal's and the diff's
  choices, each read back field by field and unreadable storage as the defaults. Pictures and the
  queue (`toolPictures.test.ts`). Models (`modelFormats.test.ts`, `modelRefs.test.ts`): formats by
  name, the files a .gltf loads kept inside the folder, Draco and meshopt refused with a sentence,
  the JSON of a .glb, the stats line and the size, the camera's distance for a narrow view, the
  models a turn wrote or named and their place after its diagrams. The reader (`panels.test.ts`):
  a model offered as one, its buffers and textures handed over, a text file, `.env`, a path
  outside the folder, a missing file and one past 64 MB refused. Code colors
  (`codeThemes.test.ts`, `db.test.ts`): a profile from before the setting loads with Vitesse, a
  light theme can't be the dark one, the tokens' colors change with the theme, previews carry the
  theme's background. The diff (`git.test.ts`): whitespace-only changes left out when asked, and
  only then.
- Desktop (`recordings.spec.ts`): the column after a turn that wrote a file (Environment, Outputs,
  Changes with Create PR, Context opened to its parts, Connectors), the git bar giving way, a
  panel taking the column's place and giving it back, the header button; three queued messages
  folding, opening, Clear all behind its confirmation, nothing of them sent; a model named in a
  reply drawn at the end of the turn (12 triangles, 2 × 2 × 2, wireframe) and in the Files panel.

Not verified:

- macOS, at all. electron-builder builds macOS only on a Mac, and GitHub's runners did not start:
  the newest CI runs (2026-10-16) end with "The job was not started because your account is locked
  due to a billing issue". No macOS package exists.
- The full desktop suite at the release commit: it was stopped before it ran (the table). The
  rounds' tests and every spec the fixes touched were run after the fixes.
- The effort note in the app: the scripted endpoint's models have no effort levels, so only its
  texts and storage are tested.
- Pictures from a real MCP server: the scripted endpoint's models can't see pictures, and for such
  a model an MCP picture is replaced by text before it is stored. The row and the viewer were
  checked in the renderer preview with a stand-in picture.
- Real exports: Blender's and Roblox Studio's own .glb and .fbx files, Draco-compressed models,
  a .gltf with its textures beside it. The tests draw a twelve-triangle .stl.
- WebGL in the Linux container: the packaged smoke tests there draw no model.

## 0.6.33 round (2026-10-17)

Branch `feat/from-the-recordings`, on top of 0.6.32 in its worktree, local: nothing was pushed
and no release was made. Commits `8fab10e` (a message shows at once; a large folder can't hang
a turn, its Stop or its Delete), `683f157` (scrollbars), `3af972b` (connectors with their apps'
icons), `32c2b12` ("Stopped." before any reply), `947da5a` (Open a file), `14e2057` (the tour),
`529991b` (the card chooser), `b181d1f` (the version and the documents), `41d99c5` and `feb4dd0`
(what the Linux run found), `9d63bdf` (documents). Windows 11 (Node 26.7.0, Electron 44.5.1)
and a Linux container (`node:24-bookworm`). Not macOS: see the end.

| Command | Commit | Result |
| --- | --- | --- |
| `npx playwright test tests/e2e/tour.spec.ts tests/e2e/mcp.spec.ts --repeat-each 2` | working tree before `14e2057` | 10 passed |
| `npm run verify` | `b181d1f` | typecheck, lint, build exit 0; unit 134 files passed, 3 skipped, 1560 passed, 30 skipped; e2e 82 passed, 6 skipped, 483 s |
| `npm run verify:docker` | `b181d1f` | typecheck, lint, unit (1552 passed, 38 skipped), build exit 0; e2e exit 1: 80 passed, 2 failed, 6 skipped |
| the queue test with each send slowed by 400 ms, on the composer of `b181d1f` | `41d99c5` test, old composer | 1 failed, as in the container |
| `npx playwright test` of `recordings`, `session`, `chat`, `power`, `tour` | the tree then committed as `41d99c5` and `feb4dd0` | 20 passed |
| `npm run verify:docker` | `9d63bdf` | every step exit 0; unit 1554 passed, 38 skipped; e2e 82 passed, 6 skipped (7.9 min) |
| `npm run verify` | `9d63bdf` | every step exit 0; unit 134 files passed, 3 skipped, 1562 passed, 30 skipped; e2e 82 passed, 6 skipped, 485 s |
| `npm run dist:win`, then `packaged.spec.ts` against `dist/win-unpacked` | `9d63bdf` | installer built; the archive holds `out/main`, `out/preload`, `out/renderer` and `package.json` 0.6.33; 3 passed |
| `npm run dist:linux:docker` (build and `packaged` smoke test in the container) | `9d63bdf` | AppImage and .deb built; 3 passed |

What the runs found, and what was done:

- The user's "it doesn't delete or send a message": a session on a very large folder snapshotted
  it before storing the message, unstoppably, with a ten-minute timeout, and closing the session
  waited for the turn without end. Fixed in `8fab10e`; unit tests in `checkpointBudget.test.ts`
  (the message before the snapshot, the budget and its notice, Stop during the snapshot, a
  session that closes whatever the snapshot does).
- The tour (`tour.spec.ts`) found two faults on its first runs. Stop pressed right after sending
  ended the turn during the snapshot and left the message with no word under it (`32c2b12`: a
  "Stopped." notice, unit-tested in `agent.test.ts` and `checkpointBudget.test.ts`). Ctrl+P, a
  name typed and Enter at once opened another file (`947da5a`, `paletteModel.test.ts`).
- The first Linux run failed two desktop tests that pass on Windows, both real. In the queue
  test, two of three messages typed one after another were lost: the box was emptied when a send
  came back, taking what had been typed meanwhile, and an Enter before then did nothing
  (`41d99c5`; the test now slows each send and failed on the old composer on Windows too). In the
  details column, a short path such as `/tmp/project` was shown whole beside the folder's name,
  so the test found the name twice (`feb4dd0`, `detailsModel.test.ts`).

What the tests of this round show, and with what:

- Unit: the snapshot's budget and Stop (4), "Stopped." (2), server info from MCP (title, version,
  data: icons only, the largest or the SVG) in `mcp.test.ts`, the app marks by name, address and
  command and the names shown (`brands.test.ts`), the scrollbar marks (`scrollbars.test.ts`),
  hidden cards kept (`keptStates.test.ts`), the folder line (`detailsModel.test.ts`), the file
  palette's rows (`paletteModel.test.ts`).
- Desktop: `tour.spec.ts` (every Settings page and its search, every Customize tab, every view in
  both modes, the palettes, the scrollbar while scrolling, a session that writes code, the
  Terminal, Changes, Files, Search and Problems tabs, Browser, Agents, the details column and its
  card chooser, each composer menu, find, open a file, go to a symbol, Stop the moment a message
  is sent, a message after it, Delete while a reply streams; no page error, no console error, no
  part that failed to display); `mcp.spec.ts` (a server's own name and icon in Customize and in
  the Connectors card); `recordings.spec.ts` (the queue with slow sends).

Not verified:

- macOS, at all: it needs a Mac, and GitHub's runners don't start while the account is locked
  for billing.
- A real large folder: the budget and Stop are tested with snapshots that never end; the user's
  own Downloads folder was not opened.
- Icons sent by a real third-party MCP server; the fixture sends one SVG. The Roblox Studio and
  Blender marks were checked in the renderer preview.

## 0.6.34 round (2026-10-17)

Branch `feat/from-the-recordings`, on top of 0.6.33, local: nothing was pushed and no release was
made. Commits `1a72ff5` (git stopped with what it started), `f3fd4f6` (a delete that never fails on
the index folder), `a0e2cdc` (the snapshot beside the reply), `d9efa2d` (media models and video),
`59b48a3` (54 integrations), `0b2fd87` (What's new without another app's name), `7dc622d` (the
version and the documents), `30c3d75` (the live catalogue check). Windows 11 (Node 26.7.0,
Electron 44.5.1) and a Linux container (`node:24-bookworm`). Not macOS.

| Command | Commit | Result |
| --- | --- | --- |
| `npx vitest run tests/unit/git.test.ts -t "ends at once when stopped"` with the git runner of `83e8414` | `1a72ff5` test, old runner | 1 failed: the stop took 3064 ms, the length of the alias it stopped |
| `npx playwright test` of `session`, `tour`, `recordings`, `review`, `recovery` | `a0e2cdc` | 18 passed |
| `npx playwright test` of `tour`, `mcp`, `models` | `59b48a3` before commit | 6 passed |
| `npm run verify` | `7dc622d` | every step exit 0; unit 136 files passed, 3 skipped, 1585 passed, 72 skipped; e2e 83 passed, 6 skipped, 478 s |
| `GRAFT_LIVE_MCP=1 npx vitest run tests/unit/mcp.live.test.ts -t "catalogue against the real world"` | `30c3d75` | 53 passed: every package exists, every remote server answers or asks for credentials |
| `npm run verify:docker` | `30c3d75` | every step exit 0; unit 1577 passed, 80 skipped; e2e 83 passed, 6 skipped (8.0 min) |
| `npm run dist:win`, then `packaged.spec.ts` against `dist/win-unpacked` | `30c3d75` | installer built; the archive holds `out/main`, `out/preload`, `out/renderer` and `package.json` 0.6.34; 3 passed |
| `npm run dist:linux:docker` (build and `packaged` smoke test in the container) | `30c3d75` | AppImage and .deb built; 3 passed |

The 72 skipped unit tests are 30 as before plus the live tests that now cover 42 more
integrations; they run only with `GRAFT_LIVE_MCP=1`.

What the tests of this round show, and with what:

- Unit: a stopped git ends at once and, on Windows, the real git and its shell with it (`git.test.ts`,
  an alias that sleeps); a held index folder never fails a delete and goes at the next start's sweep;
  the snapshot beside the reply (`checkpointBudget.test.ts`: the model is asked at once, a Write waits
  for the snapshot, a reply in words doesn't, Stop ends the snapshot, a session closes whatever it
  does); media models by kind from OpenRouter, OpenAI and Google wire formats, names on other servers
  (`mediaModels.test.ts`); the video job submitted with a length and a shape the model makes, polled,
  downloaded from the provider's own address only, and a failed job's reason; the GenerateVideo tool
  (saving, first frame inside the project only, overwrite, no key, Ask and Plan modes); the offering
  of GenerateVideo; the media sections' model (`renderer/mediaModels.test.ts`); the catalogue (54, every
  kind used, https, a fixed environment for Zotero, keys as bearer headers).
- Desktop: `models.spec.ts` (a server listing FLUX, Wan, Kokoro and Whisper beside its chat models:
  four sections, the note instead of Use, the search, a chat list without them); `tour.spec.ts`
  (the integrations search).

Not verified:

- A real video: no clip was made with a real key (it costs money on the user's account). The job
  flow is tested against a local server that speaks OpenRouter's documented format, and the format
  was read from OpenRouter's docs and its public model list on 2026-10-17.
- Signing in to the OAuth integrations (Supabase, Neon, Cloudflare, Atlassian, Asana, Semgrep,
  Webflow) with real accounts. Their servers advertise dynamic client registration, which is what
  Graft's sign-in uses.
- Starting the 23 new local servers: their packages were checked in npm and PyPI, not run on this
  computer (some are community packages, and running them is the user's call).
- macOS.
