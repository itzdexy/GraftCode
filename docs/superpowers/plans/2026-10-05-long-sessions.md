# Long Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A long session stays cheap and keeps going: old tool output is removed before anything is summarized, a summary keeps the recent steps as they were, and a backup model takes over when the session's model keeps failing. Ships as 0.6.12.

**Architecture:** Pruning is a view of the history, never a change to stored messages: `src/main/agent/prune.ts` decides a cutoff, the session remembers it in memory, and `history()` applies it. Compaction learns to stop before the newest steps and `toLlmHistory` puts the summary ahead of them. The loop gets one optional hook, `fallback`, which the session answers from a new setting.

**Tech Stack:** TypeScript, Zod, better-sqlite3 (unchanged schema), React 18, Vitest 5, Playwright. No new packages.

**Spec:** `docs/superpowers/specs/2026-10-05-next-rounds-design.md`, section 4.4. Product spec: `docs/SPEC.md`.

## Global Constraints

- Build on what is there: the loop, `maybeCompact`, `/compact`, retries and the summary's wording keep working; a session that fits its window behaves as before.
- Stored messages are never changed or deleted by pruning; the transcript still shows everything.
- Every tool call sent to a provider keeps its result, and no result is sent without its call.
- Numbers: prune when the context passes 80% of the window; keep `min(40,000, 25% of the window)` tokens of the newest tool output and always the latest step's; stub results of 200 tokens or more; accept the prune when the context falls to 60% or less; a summary keeps `min(15,000, 10% of the window)` tokens of recent messages; all estimated with `estimateMessagesTokens`.
- The backup model is used once a turn, only for `overloaded`, `rate_limit`, `server` and `network`, only before any output, never in incognito chats, never for agents of a group.
- Stored data changes only by adding: `defaults.fallbackModel` with the default `null` in `DEFAULT_APP_SETTINGS`.
- Exact copy (stub, notices, the summary's last sentence, the setting) is in spec 4.4; use it word for word.
- Tests first. Unit tests in `tests/unit/**`. Never weaken an existing compaction test: the rules below are chosen so they still hold.
- No model names in renderer code. No commits unless the owner has asked; each task gives the message for when they do.

## Review Focus

1. A tool result that is a picture (a screenshot): it is removed like text, and its call still has a result (Task 1 test).
2. One huge result in the latest step: it always stays, pruning frees too little, and the session summarizes instead of looping (Task 1 and Task 2 tests).
3. The recent steps would start at a tool result whose call is being summarized: the kept part starts at the next reply instead (Task 3 test).
4. The backup model is the session's own, was removed, or the chat is incognito: no switch, and the original error is shown (Task 5 test).
5. Part of a reply arrived before the failure: no switch, so nothing is said twice (Task 4 test).

---

### Task 1: Removing old tool output

**Files:**
- Create: `src/main/agent/prune.ts`
- Modify: `src/main/agent/tokens.ts` (export `IMAGE_TOKENS`)
- Test: `tests/unit/prune.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PRUNE_KEEP_TOKENS = 40_000;
  export const PRUNE_MIN_TOKENS = 200;
  export function prunedStub(toolName: string): string;
  /** The seq before which tool output is removed; null when all of it fits in keepTokens. The newest message that holds results is always kept. */
  export function pruneCutoff(messages: StoredMessage[], keepTokens: number): number | null;
  /** The same messages, with results of PRUNE_MIN_TOKENS or more in messages before `beforeSeq` replaced by a stub. Nothing given is changed. */
  export function withPrunedOutput(messages: StoredMessage[], beforeSeq: number): StoredMessage[];
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import type { ContentBlock, StoredMessage } from '../../src/shared/schemas/messages';
import { pruneCutoff, prunedStub, withPrunedOutput } from '../../src/main/agent/prune';

let seq = 0;
const msg = (role: 'user' | 'assistant', content: ContentBlock[]): StoredMessage => ({ id: `m${String(++seq)}`, sessionId: 's', seq, role, content, meta: {}, createdAt: 0 });
const called = (id: string, name: string) => msg('assistant', [{ type: 'tool_use', id, name, input: {} }]);
const result = (id: string, text: string, isError = false) => msg('user', [{ type: 'tool_result', toolUseId: id, isError, content: [{ type: 'text', text }] }]);
const big = 'x'.repeat(35_000); // 10,000 tokens
const small = 'y'.repeat(350); // 100 tokens
const textOf = (m: StoredMessage) => JSON.stringify(m.content);

describe('removing old tool output', () => {
  const history = [msg('user', [{ type: 'text', text: 'go' }]), called('a', 'Read'), result('a', big), called('b', 'Grep'), result('b', big), called('c', 'Read'), result('c', big)];

  it('keeps the newest output that fits, and always the latest step', () => {
    expect(pruneCutoff(history, 100_000)).toBeNull();
    expect(pruneCutoff(history, 15_000)).toBe(history[4]!.seq + 1);
    expect(pruneCutoff(history, 1)).toBe(history[4]!.seq + 1);
    expect(pruneCutoff([history[0]!, called('z', 'Read'), result('z', big)], 1)).toBeNull();
  });

  it('puts a line in place of each removed result, naming the tool, and changes nothing it was given', () => {
    const pruned = withPrunedOutput(history, history[4]!.seq + 1);
    expect(pruned[2]!.content).toEqual([{ type: 'tool_result', toolUseId: 'a', isError: false, content: [{ type: 'text', text: prunedStub('Read') }] }]);
    expect(textOf(pruned[4]!)).toContain('[The output of this Grep call was removed to save context. Run it again if you need it.]');
    expect(pruned[6]).toBe(history[6]);
    expect(pruned[1]).toBe(history[1]);
    expect(textOf(history[2]!)).toContain(big);
  });

  it('leaves small results alone, and removes pictures and long errors like anything else', () => {
    const picture = msg('user', [{ type: 'tool_result', toolUseId: 'p', isError: false, content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] }]);
    const mixed = [called('s', 'Glob'), result('s', small), called('p', 'Browser'), picture, called('e', 'Shell'), result('e', big, true), called('n', 'Read'), result('n', small)];
    const pruned = withPrunedOutput(mixed, mixed[7]!.seq);
    expect(pruned[1]).toBe(mixed[1]);
    expect(textOf(pruned[3]!)).toContain(prunedStub('Browser'));
    expect(pruned[5]!.content[0]).toMatchObject({ type: 'tool_result', isError: true, content: [{ type: 'text', text: prunedStub('Shell') }] });
    expect(prunedStub('')).toBe('[The output of this tool call was removed to save context. Run it again if you need it.]');
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/prune.test.ts`
Expected: FAIL, cannot find `src/main/agent/prune`.

- [ ] **Step 3: Write `prune.ts`**

A result's size is `estimateTextTokens` of its text plus `IMAGE_TOKENS` for each picture. `pruneCutoff` walks the messages from the newest: the first one holding results is kept whatever its size, and its size starts a running total; each older message's result tokens are added to that total, and the function returns that message's `seq + 1` as soon as the total passes `keepTokens`. `withPrunedOutput` finds each result's tool name from the `tool_use` with the same id in an earlier message (`tool` when there is none) and returns new message objects only for messages it changes.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/prune.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src/main/agent/prune.ts src/main/agent/tokens.ts tests/unit/prune.test.ts
git commit -m "feat(core): decide which old tool output can go"
```

---

### Task 2: The session prunes before it summarizes

**Files:**
- Modify: `src/main/agent/session.ts` (`history`, `maybeCompact` in `makeHost`, a `pruneBeforeSeq` field, `/clear` resets it)
- Test: `tests/unit/agent.test.ts`

**Interfaces:**
- Consumes: `pruneCutoff`, `withPrunedOutput`, `PRUNE_KEEP_TOKENS` (Task 1).
- Produces: `const PRUNE_TARGET = 0.6;` in `session.ts`, and the notice `Removed old tool output to make room.` at level `info`.

- [ ] **Step 1: Write the failing test**

In `describe('compaction')`:

```ts
it('removes old tool output instead of summarizing when that makes enough room', async () => {
  const h = harness({
    model: { contextWindow: 20_000 },
    script: [
      { toolCalls: [{ name: 'Read', input: { file_path: 'a.txt' } }], usage: { inputTokens: 2000, outputTokens: 20 } },
      { toolCalls: [{ name: 'Read', input: { file_path: 'b.txt' } }], usage: { inputTokens: 17_000, outputTokens: 20 } },
      { text: 'Both read.' }
    ]
  });
  writeFile(h.projectDir, 'a.txt', Array.from({ length: 300 }, (_, i) => `alpha ${String(i)} ${'x'.repeat(90)}`).join('\n'));
  writeFile(h.projectDir, 'b.txt', 'beta marker\n');
  h.session.send('read both');
  await h.session.idle();
  expect(h.provider.requests).toHaveLength(3);
  expect(h.provider.requests.some((r) => /summarize a coding session/.test(r.system))).toBe(false);
  const sent = JSON.stringify(h.provider.requests[2]!.messages);
  expect(sent).toContain('[The output of this Read call was removed to save context. Run it again if you need it.]');
  expect(sent).not.toContain('alpha 150');
  expect(sent).toContain('beta marker');
  expect(h.events.some((e) => e.type === 'notice' && e.text === 'Removed old tool output to make room.')).toBe(true);
  // Nothing stored was changed: the transcript still shows what the tool returned.
  const stored = h.store.listMessages('session-1');
  expect(JSON.stringify(stored)).toContain('alpha 150');
  expect(stored.some((m) => m.meta.compacted)).toBe(false);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/unit/agent.test.ts -t "removes old tool output"`
Expected: FAIL (the script runs out: a summary was asked for).

- [ ] **Step 3: Prune in `maybeCompact`, and apply the cutoff in `history()`**

`history()` passes its messages through `withPrunedOutput(kept, this.pruneBeforeSeq)` before `toLlmHistory`. In `maybeCompact`, when the threshold is passed and the provider has not just refused the request (`overflow` is false): take the session's uncompacted messages, `cutoff = pruneCutoff(messages, Math.min(PRUNE_KEEP_TOKENS, Math.floor(model.contextWindow * 0.25)))`; when it is not null and greater than `this.pruneBeforeSeq`, estimate the saving as `estimateMessagesTokens` of the history with today's cutoff minus that with the new one; when `tokens - saving <= model.contextWindow * PRUNE_TARGET`, set `this.pruneBeforeSeq = cutoff`, emit the notice and return `this.history()`. In every other case fall through to `this.compact('', signal)`. `/clear` sets `pruneBeforeSeq` back to 0. The existing test `summarizes near the context limit and continues from the summary` must still pass unchanged: its only result is the latest step's, so nothing can be pruned.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/agent.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src/main/agent/session.ts tests/unit/agent.test.ts
git commit -m "feat(core): remove old tool output before summarizing"
```

---

### Task 3: A summary keeps the recent steps

**Files:**
- Modify: `src/main/agent/history.ts` (`modelOrder`, used by `toLlmHistory`), `src/main/agent/compaction.ts` (`compactionCut`, `COMPACT_KEEP_TOKENS`, `summaryMessageText`), `src/main/agent/session.ts` (`compact`)
- Test: `tests/unit/agent.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // history.ts — the newest compaction summary goes ahead of the uncompacted messages stored before it
  export function modelOrder(messages: StoredMessage[]): StoredMessage[];
  // compaction.ts
  export const COMPACT_KEEP_TOKENS = 15_000;
  /** Index where the kept part starts: a reply, with everything from it on within keepTokens. messages.length when nothing is kept. */
  export function compactionCut(messages: StoredMessage[], keepTokens: number): number;
  export function summaryMessageText(summary: string, todos: TodoItem[], files: string[], extra?: { plan?: string | null; keptRecent?: boolean }): string;
  ```
  `plan` belongs to the plans plan. If that plan ran first, `extra` already exists: add `keptRecent` to it. If not, add `extra` with `keptRecent` only.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/agent.test.ts`, inside `describe('compaction')` (helpers as in `tests/unit/prune.test.ts`; copy `msg`, `called`, `result`, `big`, `small`):

```ts
it('cuts where the newest steps fit, at a reply', () => {
  const said = msg('assistant', [{ type: 'text', text: 'Done so far.' }]);
  const m = [msg('user', [{ type: 'text', text: 'go' }]), called('a', 'Read'), result('a', big), called('b', 'Read'), result('b', small), said, msg('user', [{ type: 'text', text: 'next' }])];
  expect(compactionCut(m, 400)).toBe(3);
  // The newest that fit start at a tool result: the kept part starts at the reply after it.
  expect(compactionCut(m, 125)).toBe(5);
  expect(compactionCut(m, 20)).toBe(5);
  expect(compactionCut(m, 1)).toBe(m.length);
});

it('sends the newest summary ahead of the steps kept from before it', () => {
  const [t1, t2, n1] = [called('k', 'Read'), result('k', small), msg('user', [{ type: 'text', text: 'more' }])];
  const summary: StoredMessage = { ...msg('user', [{ type: 'text', text: 'Summary' }]), meta: { kind: 'compaction-summary' } };
  expect(modelOrder([t1, t2, summary, n1])).toEqual([summary, t1, t2, n1]);
  expect(modelOrder([t1, t2, n1])).toEqual([t1, t2, n1]);
  expect(toLlmHistory([t1, t2, summary, n1]).map((x) => x.role)).toEqual(['user', 'assistant', 'user']);
});

it('summarizes the older part and leaves the latest steps as they were', async () => {
  const h = harness({
    model: { contextWindow: 4000 },
    script: [
      { toolCalls: [{ name: 'Read', input: { file_path: 'a.txt' } }], usage: { inputTokens: 1000, outputTokens: 20 } },
      { toolCalls: [{ name: 'Read', input: { file_path: 'b.txt' } }], usage: { inputTokens: 2000, outputTokens: 20 } },
      { toolCalls: [{ name: 'Read', input: { file_path: 'c.txt' } }], usage: { inputTokens: 3300, outputTokens: 20 } },
      { text: 'They read two long files.' },
      { text: 'All three read.' }
    ]
  });
  const long = (word: string) => Array.from({ length: 20 }, (_, i) => `${word} ${String(i)} ${'x'.repeat(90)}`).join('\n');
  writeFile(h.projectDir, 'a.txt', long('alpha'));
  writeFile(h.projectDir, 'b.txt', long('beta'));
  writeFile(h.projectDir, 'c.txt', 'gamma marker\n');
  h.session.send('read three');
  await h.session.idle();
  expect(h.provider.requests[3]!.system).toMatch(/summarize a coding session/);
  // The summarizer got what is being replaced, not the steps that stay.
  expect(JSON.stringify(h.provider.requests[3]!.messages)).not.toContain('gamma marker');
  const after = h.provider.requests[4]!.messages;
  expect(after).toHaveLength(3);
  expect(JSON.stringify(after[0])).toContain('This session was compacted');
  expect(JSON.stringify(after[0])).toContain('The most recent steps follow this summary unchanged.');
  expect(after[1]!.role).toBe('assistant');
  expect(JSON.stringify(after[2])).toContain('gamma marker');
  expect(JSON.stringify(after)).not.toContain('alpha 10');
  expect(texts(h).at(-1)).toBe('assistant:All three read.');
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/agent.test.ts -t "cuts where|newest summary|summarizes the older part"`
Expected: FAIL (`compactionCut` and `modelOrder` do not exist; the continuation has one message).

- [ ] **Step 3: Write the cut, the order and the new `compact`**

`compactionCut` sums `estimateMessagesTokens([{ role, content }])` message by message from the newest while the total stays within `keepTokens`, then moves the start forward to the first `assistant` message; with none it returns `messages.length`. `modelOrder` finds the last message whose `meta.kind` is `compaction-summary` and, when it is not already first, returns it followed by the messages before it and then the ones after. `toLlmHistory` applies `modelOrder` to its visible messages. `compact()` orders its uncompacted messages with `modelOrder`, takes `cut = compactionCut(ordered, Math.min(COMPACT_KEEP_TOKENS, Math.floor(model.contextWindow * 0.1)))`, and summarizes `ordered.slice(0, cut)` when `cut >= 2`, everything otherwise. It marks only what it summarized as compacted, passes `keptRecent` (true when something stayed) to `summaryMessageText`, which then ends with spec 4.4's sentence instead of today's last line, and returns `this.history()`. The existing compaction tests must pass unchanged: in each of them fewer than two messages come before the cut.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/agent.test.ts tests/unit/missionSession.test.ts`
Expected: PASS, every test in both files.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src/main/agent tests/unit/agent.test.ts
git commit -m "feat(core): a summary keeps the recent steps as they were"
```

---

### Task 4: A backup model in the loop

**Files:**
- Modify: `src/main/agent/loop.ts` (`LoopModel`, `LoopHost.fallback`, the request and failure paths of `runAgentLoop`), `tests/support/loopHarness.ts` (a `backup` option)
- Test: `tests/unit/loop.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // loop.ts
  export interface LoopModel { provider: LLMProvider; model: ModelInfo; effort: EffortLevel | null }
  // in LoopHost
  /** Another model to finish the turn with, after `error` ended a request before any output; null when there is none. */
  fallback?(error: ProviderError): Promise<LoopModel | null>;
  // tests/support/loopHarness.ts
  backup?: FakeStep[];                   // in LoopHarnessOptions: the replies of a second model the host offers as fallback
  backup: FakeProvider | null;           // in LoopHarness; its model is { providerId: 'backup', modelId: 'backup-model' }, labelled 'Backup Model'
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe('a model that keeps failing', () => {
  const overloaded = new ProviderError('overloaded', 'The provider is overloaded (529).');

  it('hands the turn to the backup model and says so', async () => {
    const h = makeLoopHarness({ tools: [], script: [{ error: overloaded }], backup: [{ text: 'Answered by the backup.' }] });
    const result = await h.run('hello');
    expect(result).toMatchObject({ reason: 'completed', finalText: 'Answered by the backup.' });
    expect(h.notices()).toEqual(["Fake Model isn't answering (overloaded). Continuing with Backup Model."]);
    expect(h.stored.at(-1)?.meta.model).toEqual({ providerId: 'backup', modelId: 'backup-model' });
    expect(h.backup!.requests[0]!.model.ref.modelId).toBe('backup-model');
  });

  it('names the other reasons, and stays put for failures another model would not fix', async () => {
    for (const [code, reason] of [['rate_limit', 'rate limited'], ['server', 'server error'], ['network', 'unreachable']] as const) {
      const h = makeLoopHarness({ tools: [], script: [{ error: new ProviderError(code, 'x') }], backup: [{ text: 'ok' }] });
      await h.run('hello');
      expect(h.notices()[0]).toBe(`Fake Model isn't answering (${reason}). Continuing with Backup Model.`);
    }
    for (const code of ['auth', 'bad_request', 'context_length'] as const) {
      const h = makeLoopHarness({ tools: [], script: [{ error: new ProviderError(code, 'x') }], backup: [{ text: 'never' }] });
      expect((await h.run('hello')).error).toMatchObject({ code });
      expect(h.backup!.requests).toHaveLength(0);
    }
  });

  it('does not switch once part of a reply has arrived', async () => {
    const h = makeLoopHarness({ tools: [], script: [{ error: overloaded, partialText: 'Half an ans' }], backup: [{ text: 'never' }] });
    expect((await h.run('hello')).reason).toBe('error');
    expect(h.backup!.requests).toHaveLength(0);
  });

  it('switches once: the backup model’s own failure ends the turn', async () => {
    const h = makeLoopHarness({ tools: [], script: [{ error: overloaded }], backup: [{ error: new ProviderError('server', 'Provider error (500).') }] });
    expect((await h.run('hello')).error).toMatchObject({ code: 'server' });
    expect(h.backup!.requests).toHaveLength(1);
  });
});
```

`context_length` in the second test relies on the harness's default `maybeCompact` returning null: the loop's own recovery gives up and reports the error.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/loop.test.ts -t "keeps failing"`
Expected: FAIL (`backup` is not a harness option).

- [ ] **Step 3: Add the hook and the harness option**

The loop keeps `let active: LoopModel = { provider: config.provider, model: config.model, effort: config.effort }` and uses it wherever it used those three: the request, `streamWithRetry`, `usageCost` and the stored message's `meta.model`. After a request fails with nothing received (`content.length === 0`), one of the four codes, no earlier switch this turn and a `host.fallback`: await it; when it returns a model, make it `active`, send the history without thinking from then on (as `config.stripThinking` does), emit the notice at level `warning`, take the iteration back and continue. The context-length recovery above it keeps its place. In the harness, `backup` creates a second `FakeProvider` (id `backup`) and sets `host.fallback` to return it with its model and `effort: null`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/loop.test.ts tests/unit/agent.test.ts tests/unit/agentGroup.test.ts`
Expected: PASS, every test in the three files.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src/main/agent/loop.ts tests/support/loopHarness.ts tests/unit/loop.test.ts
git commit -m "feat(core): let a turn continue on a backup model"
```

---

### Task 5: The setting and the session's side

**Files:**
- Modify: `src/shared/schemas/appSettings.ts` (`defaults.fallbackModel`, its default), `src/main/agent/session.ts` (`SessionPreferences.fallbackModel`, the host's `fallback`), `src/main/agent/sessionManager.ts` (preferences), `src/renderer/src/features/settings/ModelsSection.tsx`, `tests/support/sessionHarness.ts` (option `fallbackModel`)
- Test: `tests/unit/agent.test.ts`, `tests/unit/system.test.ts`, `tests/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: `LoopModel`, `LoopHost.fallback` (Task 4).
- Produces:
  ```ts
  // appSettings.ts, in `defaults`
  fallbackModel: ModelRefSchema.nullable()        // DEFAULT_APP_SETTINGS.defaults.fallbackModel = null
  // SessionPreferences
  fallbackModel: ModelRef | null;
  ```

- [ ] **Step 1: Write the failing tests**

In `tests/unit/agent.test.ts`, inside `describe('cancellation, retries and errors')`:

```ts
describe('the backup model from Settings', () => {
  const backup = fakeModel({ ref: { providerId: 'fake', modelId: 'backup-model' }, label: 'Backup Model' });
  const busy = { error: new ProviderError('overloaded', 'busy') };

  it('finishes the turn when the session model keeps failing', async () => {
    const h = harness({ models: [fakeModel(), backup], fallbackModel: backup.ref, script: [busy, busy, busy, { text: 'From the backup.' }] });
    h.session.send('hi');
    await h.session.idle();
    expect(texts(h).at(-1)).toBe('assistant:From the backup.');
    expect(h.provider.requests.at(-1)!.model.ref.modelId).toBe('backup-model');
    expect(h.events.some((e) => e.type === 'notice' && e.text === "Fake Model isn't answering (overloaded). Continuing with Backup Model.")).toBe(true);
    expect(h.session.summary.status).toBe('idle');
  });

  it('is not used when it is the session’s own model, when it is gone, or in an incognito chat', async () => {
    for (const options of [
      { fallbackModel: fakeModel().ref },
      { fallbackModel: { providerId: 'fake', modelId: 'removed-model' } },
      { models: [fakeModel(), backup], fallbackModel: backup.ref, kind: 'chat' as const, incognito: true }
    ]) {
      const h = harness({ ...options, script: [busy, busy, busy] });
      h.session.send('hi');
      await h.session.idle();
      expect(h.session.summary.lastError).toMatchObject({ code: 'overloaded' });
      expect(h.provider.requests).toHaveLength(3);
    }
  });
});
```

In `tests/unit/system.test.ts`:

```ts
it('gives installs from before the backup model no backup model, and keeps their other defaults', () => {
  expect(DEFAULT_APP_SETTINGS.defaults.fallbackModel).toBeNull();
  const stored = { model: { providerId: 'p', modelId: 'm' }, effort: 'high', permissionMode: 'auto', useWorktree: true, lastProjectPath: null };
  expect(AppSettingsSchema.shape.defaults.parse({ ...DEFAULT_APP_SETTINGS.defaults, ...stored })).toEqual({ ...stored, fallbackModel: null });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/agent.test.ts tests/unit/system.test.ts -t "backup model"`
Expected: FAIL (`fallbackModel` is not a harness option or a setting).

- [ ] **Step 3: Add the setting, answer the hook, and show it in Settings**

The session's loop host gets `fallback`: it returns null in an incognito chat, without a `fallbackModel`, or when that is the turn's own model; otherwise it resolves the reference with `this.deps.models.resolve` (null, with a warning in the log, when that throws) and returns it with `this.effortFor(model)`. Agents of a group and sub-agents get no `fallback`. The session manager maps `s.defaults.fallbackModel`. In `ModelsSection.tsx`, after the `Default model` group and built like it: a `Group` titled `Backup model` with spec 4.4's description, a `ModelListbox` with `label="Backup model"` whose choice saves `{ defaults: { fallbackModel: model.ref } }`, and a ghost `None` button that saves `null` and is disabled when none is set.

- [ ] **Step 4: Run the tests, and add the settings check to the end-to-end suite**

Run: `npx vitest run tests/unit/agent.test.ts tests/unit/system.test.ts && npm run typecheck`
Expected: PASS; no type errors.

Add to `tests/e2e/settings.spec.ts`, in the test that opens Settings → Models:

```ts
const backup = w.getByRole('listbox', { name: 'Backup model' });
await backup.getByRole('option', { name: /Graft Test Mini/ }).first().click();
const saved = async () => (await w.evaluate(async () => (await (window as unknown as { graft: { invoke(c: string, i: unknown): Promise<{ value: { defaults: { fallbackModel: unknown } } }> } }).graft.invoke('settings:get', undefined)).value.defaults.fallbackModel));
await expect.poll(saved).toMatchObject({ modelId: 'graft-test-mini' });
await w.getByRole('button', { name: 'None' }).click();
await expect.poll(saved).toBeNull();
```

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src tests
git commit -m "feat(core): a backup model in Settings for when a model keeps failing"
```

---

### Task 6: Release 0.6.12

**Files:**
- Modify: `package.json`, `package-lock.json`, `src/renderer/src/features/home/releaseNotes.json`, `README.md`, `docs/PRODUCT_ROADMAP.md`, `resources/catalog/models.json` (by `npm run catalog`)

- [ ] **Step 1: Refresh the model list, bump the version, write the notes**

Run `npm run catalog`. Set `0.6.12` in `package.json` and both root entries of `package-lock.json`. Add at the top of `releaseNotes.json`:

```json
{
  "version": "0.6.12",
  "date": "YYYY-MM-DD",
  "items": [
    "Long sessions last longer. When the context fills up, Graft first drops the output of old tool calls, which the agent can run again, and only summarizes when that is not enough. The transcript still shows everything.",
    "A summary no longer starts the agent from scratch: the latest steps stay exactly as they were, after the summary of what came before.",
    "A backup model. Choose one in Settings → Models, and when a session's model is overloaded, rate limited or unreachable after its retries, the turn continues on the backup and says so."
  ]
}
```

In `README.md`, extend "Models and providers" with the backup model and add a sentence on pruning to the code-session list. In `docs/PRODUCT_ROADMAP.md`, add `### 0.6.12` under Completed; remove "Compaction is all or nothing" and "No model fallback" from the weaknesses; add that the prune cutoff lives in memory (a restarted session prunes again when it next fills up) and that agents of a group have no backup model; strike items 1 and 2 from "Next, in order".

- [ ] **Step 2: Verify the whole round**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: no errors; every unit test passes.
Run: `docker desktop start`, then `npm run test:e2e:docker` (if the script is missing, create it from spec section 6), then `docker desktop stop`
Expected: `0 failed`. Report the exact counts.

- [ ] **Step 3: Commit (only when the owner has asked for commits)**

```bash
git add -A
git commit -m "chore: 0.6.12 notes"
```
