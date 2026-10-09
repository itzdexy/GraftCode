# Graft upgrade execution plan

Baseline commit: `975da443e02b2c95aaede17d53e1ddd35b314031`, version 0.6.14.
Work branch: `codex/graft-polish-reliability`. This record extends
`IMPLEMENTATION_STATUS.md`; existing features and profile data are preserved.

## Current execution order

1. Reproduce unsafe provider stream completion and session snapshot races;
   fix them with regression coverage before expanding interface behavior.
2. Diagnose the attached garbled response, distinguish endpoint output from
   renderer defects, and provide honest recovery guidance without rewriting it.
3. Extend existing motion tokens and reduced-motion settings across shared
   controls, queued inputs and work status; avoid continuous paint-heavy effects.
4. Measure long transcript work, optimize proven repeated work, and verify
   actual streamed/cancelled/resumed desktop flows.
5. Extend workspace capabilities on the existing Monaco/draft/LSP foundation
   when prior gates pass; preserve revision and trust checks.
6. Run static, unit, desktop and Windows packaging checks; record exact results,
   local commits, remaining roadmap scope and environmental blockers.

## Architecture boundaries

Main owns provider requests, agent tools, filesystem permissions, language servers,
SQLite and secrets. The sandboxed renderer uses validated preload IPC and Zustand
views. Provider terminal confirmation must precede tool execution. A pending detail
request must not restore stale message, queue or approval state over newer events.
Visual motion uses existing CSS tokens and the persisted motion preference.

## Larger brief

The full engineering brief also requests best-of-N with objective verification,
durable execution replay, budgets, editor splits/layouts/semantic edits, repository
indexing, model comparison, more lifecycle authorities, research provenance,
permission/sandbox hardening and cross-platform release readiness. These remain
subject to real implementation and tests; they are not implied complete by this
run's first fixes. Progress and verification are recorded separately.
