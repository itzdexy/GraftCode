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
| Production build | Passed for 0.6.15. Known Monaco large-chunk warning remains. |
| Windows packaging | Completed; 0.6.15 NSIS installer and unpacked executable created. Desktop/packaged/installed final gates pending. |

The benchmark command uses `--disableConsoleIntercept` to capture real measurements:
500 turns, 120 live updates, full projection 38.37 ms versus cached projection
0.88 ms. This measures the production projection functions, not an app-wide speedup.

Protocol references: [OpenAI Chat streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)
and [Ollama API source](https://github.com/ollama/ollama/blob/main/docs/api.md).
No private provider endpoint generation quality or cross-platform result is claimed.
