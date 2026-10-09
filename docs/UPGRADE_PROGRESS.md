# Graft upgrade progress

Baseline and current committed source: `975da44`, version 0.6.14.
Branch: `codex/graft-polish-reliability`.

## Audit and evidence

- Read the supplied brief, existing implementation/roadmap/spec and actual
  provider, transcript, motion, store and database architecture.
- Existing 0.6.14 includes independent model refresh, writer worktrees, TypeScript
  LSP, Monaco saves and SQLite draft recovery. Extend these rather than replace them.
- Screenshot response is stored with `<|close|>`/`<|open|>` and a replacement
  character from an OpenAI-compatible Kimi model. The UI is not the origin of
  these stored strings. No paid requests were made for diagnosis and no keys or
  conversation text were printed.
- OpenAI Chat/Ollama stream EOF can be misclassified as successful completion.
- Detail-loading races can overwrite post-request events and restore rewound state.
- Existing reduced-motion handling and compositor-friendly tokens provide the
  interface motion foundation; some continuous effects still animate paint.

## Current work

## Completed first milestone: execution and recovery

- OpenAI Chat requires a terminal finish reason; Ollama requires `done:true`.
  Unconfirmed tool calls are not emitted to the execution loop. Cancelled streams
  remain interrupted and visible partial text/thinking is preserved.
- Per-request session snapshot ownership protects rewinds, same-ID message edits,
  resolved approval/question state and cleared queues from late responses. Event
  overlays are coalesced and bounded; overflow preserves live state with refresh guidance.
- Relevant provider/agent/session-store suite: 154 tests passed. Five truncated
  stream fixtures and two partial-thinking cases failed before their fixes.

## Interface and workspace implementation (desktop verification in progress)

- Existing shared motion tokens now cover queued rows, loading/error/empty states
  and restrained control feedback. Reduced motion removes stagger delays;
  status clocks pause while hidden and permanent paint-heavy Taproot effects stop.
- Repeated raw model markers show endpoint troubleshooting guidance while keeping
  original text/copy and avoiding language-based quality assumptions.
- Transcript projection reuses completed turns, preserving their global turn
  indices and handling tool results/rewinds through regression comparisons.
- Persistent file tabs retain draft buffers and preview/edit modes; only bounded,
  validated path metadata is saved, with one Monaco instance mounted at a time.
- TypeScript references and symbol information are exposed in the actual editor,
  alongside existing draft diagnostics and definition navigation.

## Measured performance

The actual transcript projection pipeline on 500 turns and 120 streaming updates
measured 38.37 ms before versus 0.88 ms using the completed-turn cache in the same
process. This is a microbenchmark of projection CPU work, not startup, total UI
latency or an app-wide speedup claim.

## Known issues under investigation

The first full unit run passed 978 tests but failed one Windows language-server
fixture cleanup after cancellation with EPERM. Child shutdown ownership is under
investigation. Initial new desktop fixtures had incorrect alias-reference/menu/
project expectations; those were corrected from actual UI and TypeScript evidence,
without weakening the existing regression tests. The entire original workspace
suite remains intact.

## Next actions

Complete regression tests and rendered flow checks; measure performance;
run build and packaged checks; update this record with actual changes and commits.
The larger milestones listed in `UPGRADE_MASTER_PLAN.md` remain incomplete.
