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
