# Plans That Last Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A plan can be edited before it is approved, stays in view above the message box, survives compaction word for word, and can be asked for with `/plan`. Ships as 0.6.11.

**Architecture:** The current plan is not stored anywhere new: it is read from the messages (`src/shared/plans.ts`), as the newest plan the user approved since the last `/clear`. Approving with edits adds one optional field to the permission answer, which `ExitPlanMode` hands to the model. Compaction and the plan bar both read the same function.

**Tech Stack:** TypeScript, Zod, React 18, Radix dialog, Vitest 5, Playwright. No new packages.

**Spec:** `docs/superpowers/specs/2026-10-05-next-rounds-design.md`, section 4.3. Product spec: `docs/SPEC.md`.

## Global Constraints

- Build on what is there: Plan mode, `ExitPlanMode`, the approval card and the permission IPC keep working for every caller that sends no `plan`.
- A plan is model output until the user approves it; nothing in it changes permission rules.
- Stored data changes only by adding: one optional `cleared` flag in message meta. No migration.
- The edited plan is at most 50,000 characters, checked by Zod on the IPC input.
- The current plan is the newest approved plan since the last `/clear`; a rewind removes it by removing its messages.
- Exact copy (card, bar, dialog, prompts, the Plan mode section) is in spec 4.3; use it word for word.
- Tests first. Unit tests in `tests/unit/**`; renderer logic as pure functions in `tests/unit/renderer/**`.
- Interface: existing tokens and components (`Button`, `Dialog`, `Markdown`); keyboard access and accessible names on everything new.
- No commits unless the owner has asked; each task gives the message for when they do.

## Review Focus

1. The plan edited down to nothing: `Approve plan` is disabled, so an empty plan is never sent (Task 4 test).
2. An edit that only changes spacing: it is an ordinary approval, and the model is not told the plan changed (Task 2 test).
3. `/clear` after an approval: the bar goes and a later compaction carries no plan (Task 1 test).
4. A second plan rejected after one was approved: the approved one stays current (Task 1 test).
5. A plan longer than 50,000 characters: the box stops there and the IPC refuses more, so nothing is cut silently in between (Task 2 test).

---

### Task 1: The current plan

**Files:**
- Create: `src/shared/plans.ts`
- Modify: `src/shared/schemas/messages.ts` (`MessageMetaSchema`), `src/main/agent/session.ts` (`commandOutput`, the `clear` command)
- Test: `tests/unit/plans.test.ts`, `tests/unit/agent.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // messages.ts, in MessageMetaSchema
  cleared: z.boolean().optional()      // on the message /clear leaves: nothing before it is current any more
  // plans.ts
  export interface ApprovedPlan { plan: string; messageId: string; at: number }
  export function currentPlan(messages: StoredMessage[]): ApprovedPlan | null;
  export function planTitle(plan: string): string;                                   // at most 60 characters
  export function planProgress(todos: TodoItem[]): { done: number; total: number } | null;
  // session.ts
  private commandOutput(text: string, meta: Partial<MessageMeta> = {}): void;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/unit/plans.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ContentBlock, MessageMeta, StoredMessage } from '../../src/shared/schemas/messages';
import { currentPlan, planProgress, planTitle } from '../../src/shared/plans';

let seq = 0;
const message = (content: ContentBlock[], meta: MessageMeta = {}): StoredMessage => ({ id: `m${String(++seq)}`, sessionId: 's', seq, role: 'user', content, meta, createdAt: seq * 1000 });
const decided = (plan: string, approved: boolean): StoredMessage =>
  message([{ type: 'tool_result', toolUseId: 'p', isError: false, content: [], display: { kind: 'plan', plan, approved, feedback: null } }]);

describe('the current plan', () => {
  it('is the newest plan the user approved', () => {
    const first = decided('1. A', true);
    expect(currentPlan([message([{ type: 'text', text: 'hi' }]), first])).toEqual({ plan: '1. A', messageId: first.id, at: first.createdAt });
    expect(currentPlan([first, decided('1. B', false)])?.plan).toBe('1. A');
    expect(currentPlan([first, decided('1. C', true)])?.plan).toBe('1. C');
    expect(currentPlan([decided('1. D', false)])).toBeNull();
  });

  it('ends at /clear, and a plan approved after it counts again', () => {
    const cleared = message([{ type: 'text', text: 'Context cleared.' }], { kind: 'command-output', cleared: true });
    expect(currentPlan([decided('1. A', true), cleared])).toBeNull();
    expect(currentPlan([decided('1. A', true), cleared, decided('1. E', true)])?.plan).toBe('1. E');
  });

  it('is named by its first heading or line, and counts the tasks done', () => {
    expect(planTitle('## Add rate limiting\n\n1. Read the router')).toBe('Add rate limiting');
    expect(planTitle('\n**Goal:** ship `v2`\nmore')).toBe('Goal: ship v2');
    const long = planTitle(`${'word '.repeat(30)}end`);
    expect(long).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
    expect(planProgress([])).toBeNull();
    expect(planProgress([{ id: '1', content: 'a', status: 'completed' }, { id: '2', content: 'b', status: 'in_progress' }, { id: '3', content: 'c', status: 'pending' }])).toEqual({ done: 1, total: 3 });
  });
});
```

In `tests/unit/agent.test.ts`, inside `describe('commands, memory and history')`:

```ts
it('marks where /clear happened', async () => {
  const h = harness({ script: [{ text: 'hello' }] });
  h.session.send('hi');
  await h.session.idle();
  h.session.send('/clear');
  await h.session.idle();
  expect(h.store.listMessages('session-1').at(-1)?.meta).toMatchObject({ kind: 'command-output', cleared: true });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/plans.test.ts tests/unit/agent.test.ts -t "plan|clear"`
Expected: FAIL, cannot find `src/shared/plans`; `cleared` is undefined.

- [ ] **Step 3: Write `plans.ts`, add the flag, and set it in `/clear`**

`currentPlan` walks the messages from the newest, stops with `null` at one whose `meta.cleared` is true, and returns the first `tool_result` it meets whose `display` is `{ kind: 'plan', approved: true }`. `planTitle` takes the first non-empty line, drops leading `#`, list marks and the characters `*`, `_` and `` ` ``, and cuts to 59 characters plus `…` when longer than 60. `commandOutput` spreads `meta` after `kind: 'command-output'`; the `clear` case passes `{ cleared: true }`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/plans.test.ts tests/unit/agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src/shared/plans.ts src/shared/schemas/messages.ts src/main/agent/session.ts tests/unit/plans.test.ts tests/unit/agent.test.ts
git commit -m "feat(plans): read the current plan from the conversation"
```

---

### Task 2: Approving an edited plan

**Files:**
- Modify: `src/shared/schemas/permissions.ts` (`PermissionResponseSchema`), `src/main/agent/loop.ts` (`PermissionAnswer`), `src/main/agent/session.ts` (`respondPermission`, `approvePlan` in `toolContext`), `src/main/tools/types.ts` (`ToolContext.approvePlan`), `src/main/tools/agentTools.ts` (`exitPlanModeTool`), `tests/support/toolContext.ts`
- Test: `tests/unit/agent.test.ts`, `tests/unit/permissions.test.ts`

**Interfaces:**
- Consumes: `currentPlan` (Task 1), for the assertions.
- Produces:
  ```ts
  // PermissionResponseSchema
  plan: z.string().max(50_000).optional()
  // loop.ts
  export interface PermissionAnswer { decision: PermissionDecision; feedback?: string; plan?: string }
  // ToolContext
  approvePlan(plan: string): Promise<{ approved: boolean; feedback: string | null; plan: string }>;   // plan: the version to follow
  ```

- [ ] **Step 1: Write the failing tests**

In `tests/unit/agent.test.ts`, after `'blocks writes in plan mode until the plan is approved'`:

```ts
const planned = async (answer: (id: string) => Parameters<Harness['session']['respondPermission']>[0]) => {
  const h = harness({ mode: 'plan', script: [{ toolCalls: [{ name: 'ExitPlanMode', input: { plan: '1. Write a.txt' } }] }, { text: 'Working.' }] });
  h.session.send('plan it');
  const prompt = await h.waitFor((e) => e.type === 'permission');
  if (prompt.type !== 'permission') throw new Error('unreachable');
  h.session.respondPermission(answer(prompt.request.id));
  await h.session.idle();
  return { h, told: JSON.stringify(h.provider.requests[1]!.messages.at(-1)) };
};

it('carries out the version of the plan the user approved', async () => {
  const { h, told } = await planned((requestId) => ({ requestId, decision: 'allow-once', plan: '1. Write a.txt\n2. Test it' }));
  expect(told).toContain('The user approved the plan after editing it. Plan mode is off; carry out their version:');
  expect(told).toContain('2. Test it');
  expect(currentPlan(h.store.listMessages('session-1'))?.plan).toBe('1. Write a.txt\n2. Test it');
  expect(h.session.summary.permissionMode).toBe('auto-edit');
});

it('treats an edit that changes nothing but spacing as a plain approval', async () => {
  const { h, told } = await planned((requestId) => ({ requestId, decision: 'allow-once', plan: '  1. Write a.txt \n' }));
  expect(told).toContain('The user approved the plan. Plan mode is off; carry out the plan now.');
  expect(told).not.toContain('after editing');
  expect(currentPlan(h.store.listMessages('session-1'))?.plan).toBe('1. Write a.txt');
});
```

In `tests/unit/permissions.test.ts`:

```ts
it('takes an edited plan with an approval, up to 50,000 characters', () => {
  const answer = { requestId: 'r', decision: 'allow-once' as const };
  expect(PermissionResponseSchema.safeParse({ ...answer, plan: 'x'.repeat(50_000) }).success).toBe(true);
  expect(PermissionResponseSchema.safeParse({ ...answer, plan: 'x'.repeat(50_001) }).success).toBe(false);
  expect(PermissionResponseSchema.safeParse(answer).success).toBe(true);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/agent.test.ts tests/unit/permissions.test.ts -t "plan"`
Expected: FAIL (the edited plan is dropped; the schema refuses the field).

- [ ] **Step 3: Pass the plan through**

`respondPermission` resolves the pending request with `plan: response.plan` too. The session's `approvePlan` returns `plan` as the answer's `plan` trimmed when that differs from the offered plan trimmed, otherwise the offered plan. `exitPlanModeTool.execute` uses the returned `plan` for the display, and when it differs from `input.plan` answers with spec 4.3's sentence, a blank line and the plan. `makeToolContext`'s default becomes `approvePlan: (plan) => Promise.resolve({ approved: false, feedback: null, plan })`.

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run tests/unit/agent.test.ts tests/unit/permissions.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src/shared/schemas/permissions.ts src/main tests
git commit -m "feat(plans): approve a plan with your own edits"
```

---

### Task 3: The plan outlives compaction

**Files:**
- Modify: `src/main/agent/compaction.ts` (`summaryMessageText`), `src/main/agent/session.ts` (`compact`)
- Test: `tests/unit/agent.test.ts`

**Interfaces:**
- Consumes: `currentPlan` (Task 1).
- Produces:
  ```ts
  export function summaryMessageText(summary: string, todos: TodoItem[], files: string[], extra?: { plan?: string | null; keptRecent?: boolean }): string;
  ```
  `keptRecent` belongs to the long-sessions plan. If that plan ran first, `extra` already exists: add `plan` to it. If not, add `extra` with `plan` only.

- [ ] **Step 1: Write the failing tests**

In `describe('compaction')`:

```ts
it('says the approved plan again, word for word, in the summary', async () => {
  const h = harness({
    mode: 'plan',
    model: { contextWindow: 2000 },
    script: [
      { toolCalls: [{ name: 'ExitPlanMode', input: { plan: '1. Add the limiter\n2. Run npm test' } }] },
      { toolCalls: [{ name: 'Glob', input: { pattern: '*' } }], usage: { inputTokens: 1700, outputTokens: 20 } },
      { text: 'They are adding a limiter.' },
      { text: 'Continuing.' }
    ]
  });
  h.session.send('plan it');
  const prompt = await h.waitFor((e) => e.type === 'permission');
  if (prompt.type !== 'permission') throw new Error('unreachable');
  h.session.respondPermission({ requestId: prompt.request.id, decision: 'allow-once' });
  await h.session.idle();
  const summary = h.store.listMessages('session-1').find((m) => m.meta.kind === 'compaction-summary');
  expect(JSON.stringify(summary?.content)).toContain('The plan you and the user agreed on (follow it):\\n1. Add the limiter\\n2. Run npm test');
});

it('adds no plan section when there is no plan', () => {
  expect(summaryMessageText('S', [], [])).not.toContain('The plan you and the user agreed on');
  expect(summaryMessageText('S', [], [], { plan: null })).not.toContain('The plan you and the user agreed on');
  expect(summaryMessageText('S', [], [], { plan: '1. A' })).toContain('The plan you and the user agreed on (follow it):\n1. A');
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/agent.test.ts -t "plan"`
Expected: FAIL (no plan section).

- [ ] **Step 3: Add the section and pass the plan**

`summaryMessageText` puts the plan section between the summary and the task list. `compact()` reads `currentPlan(this.deps.store.listMessages(this.id))?.plan ?? null` before it marks anything compacted and passes it in `extra`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/agent.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src/main/agent/compaction.ts src/main/agent/session.ts tests/unit/agent.test.ts
git commit -m "feat(plans): keep the approved plan through compaction"
```

---

### Task 4: Editing in the card, and the plan bar

**Files:**
- Create: `src/renderer/src/features/session/planModel.ts`, `src/renderer/src/features/session/PlanBar.tsx`
- Modify: `src/renderer/src/features/session/PermissionCard.tsx`, `src/renderer/src/features/session/SessionView.tsx` (the bar, after `MissionBar`)
- Test: `tests/unit/renderer/planModel.test.ts`

**Interfaces:**
- Consumes: `currentPlan`, `planTitle`, `planProgress`, `ApprovedPlan` (Task 1); the IPC field `plan` (Task 2).
- Produces:
  ```ts
  // planModel.ts
  export const PLAN_MAX = 50_000;
  export function planEdit(original: string, draft: string): { canApprove: boolean; plan: string | undefined };   // plan: what to send, undefined when unchanged
  export function planBarText(plan: ApprovedPlan, todos: TodoItem[]): { title: string; progress: string | null };
  // PlanBar.tsx
  export function PlanBar(props: { plan: ApprovedPlan | null; todos: TodoItem[] }): JSX.Element | null;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { planBarText, planEdit } from '../../../src/renderer/src/features/session/planModel';

describe('a plan in the interface', () => {
  it('sends an edit only when it changed something, and never an empty plan', () => {
    expect(planEdit('1. A', '1. A\n2. B')).toEqual({ canApprove: true, plan: '1. A\n2. B' });
    expect(planEdit('1. A', '  1. A \n')).toEqual({ canApprove: true, plan: undefined });
    expect(planEdit('1. A', '   ')).toEqual({ canApprove: false, plan: undefined });
  });

  it('names the plan and says how far the tasks are', () => {
    const plan = { plan: '## Add rate limiting\n\n1. Read the router', messageId: 'm', at: 1 };
    expect(planBarText(plan, [])).toEqual({ title: 'Plan: Add rate limiting', progress: null });
    expect(planBarText(plan, [{ id: '1', content: 'a', status: 'completed' }, { id: '2', content: 'b', status: 'pending' }])).toEqual({ title: 'Plan: Add rate limiting', progress: '1 of 2 done' });
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/renderer/planModel.test.ts`
Expected: FAIL, cannot find `planModel`.

- [ ] **Step 3: Write the model, the card's edit state and the bar**

In `PermissionCard`, when `isPlan`: a ghost `Edit plan` button (key `2`, so feedback moves to `3`) replaces the plan's display with a `textarea` labelled `Plan`, in the mono face, 12 rows, `maxLength={PLAN_MAX}`, starting from the offered plan, with the helper line under it. `Approve plan` is disabled while `!planEdit(...).canApprove`, and sends `plan` from `planEdit` with the decision. `PlanBar` returns null without a plan; otherwise a button styled like `MissionBar`'s row showing the two texts of `planBarText`, which opens a `Dialog` titled `Plan` with the plan through `Markdown` and a `Copy` button (`navigator.clipboard.writeText(plan.plan)`, then a success toast `Copied the plan`). `SessionView` computes `currentPlan(view.messages)` with `useMemo` and renders `<PlanBar plan={…} todos={view.todos} />` for code sessions.

- [ ] **Step 4: Run the tests and the renderer type check**

Run: `npx vitest run tests/unit/renderer && npx tsc -p tsconfig.web.json --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src/renderer/src/features/session tests/unit/renderer/planModel.test.ts
git commit -m "feat(plans): edit a plan in its card, and keep it above the message box"
```

---

### Task 5: `/plan`, and a better brief

**Files:**
- Modify: `src/main/agent/slashCommands.ts` (`BUILTIN_COMMANDS`, `planPrompt`), `src/main/agent/session.ts` (`handleSlash`), `src/main/agent/systemPrompt.ts` (the `# Plan mode` section)
- Test: `tests/unit/agent.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function planPrompt(task: string): string;   // "Plan this before changing anything: <task>"
  ```
  and the command `{ name: 'plan', description: 'Plan a change before making it: nothing is changed until you approve', argumentHint: '[what to plan]' }`, listed after `permissions`.

- [ ] **Step 1: Write the failing test**

In `describe('prompt commands')`:

```ts
it('/plan turns Plan mode on and asks for a plan of what was typed', async () => {
  const h = harness({ mode: 'auto-edit', script: [{ text: 'Here is the plan.' }] });
  h.session.send('/plan add rate limiting to the API');
  await h.session.idle();
  expect(h.session.summary.permissionMode).toBe('plan');
  expect(JSON.stringify(h.provider.requests[0]!.messages.at(-1))).toContain('Plan this before changing anything: add rate limiting to the API');
  expect(h.provider.requests[0]!.system).toContain('ask up to three questions with AskUserQuestion before you plan');
  expect(h.provider.requests[0]!.system).toContain('The user can edit the plan before approving it; follow the version they approve.');
  h.session.send('/plan');
  await h.session.idle();
  expect(texts(h).at(-1)).toBe('assistant:Plan mode is on. Describe what you want planned.');
  expect(h.provider.requests).toHaveLength(1);

  const chat = harness({ kind: 'chat', script: [] });
  chat.session.send('/plan a trip');
  await chat.session.idle();
  expect(texts(chat).at(-1)).toBe('assistant:Plan mode works in code sessions. Here, just ask for a plan.');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/unit/agent.test.ts -t "/plan turns"`
Expected: FAIL (`/plan …` is sent as typed).

- [ ] **Step 3: Add the command and replace the section**

`case 'plan'` in `handleSlash`: a chat gets its sentence and nothing is sent; a code session calls `this.setPermissionMode('plan')`, then returns `{ text: planPrompt(slash.args), typed: item.text }`, or with no text prints its sentence and returns null. Replace the `# Plan mode` lines of `buildCodeSystemPrompt` with spec 4.3's block.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/agent.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src/main/agent tests/unit/agent.test.ts
git commit -m "feat(plans): /plan, and a brief that asks before it plans"
```

---

### Task 6: Release 0.6.11

**Files:**
- Modify: `tests/e2e/session.spec.ts`, `package.json`, `package-lock.json`, `src/renderer/src/features/home/releaseNotes.json`, `README.md`, `docs/PRODUCT_ROADMAP.md`, `resources/catalog/models.json` (by `npm run catalog`)

- [ ] **Step 1: Write the end-to-end test**

```ts
test('a plan is edited before it is approved, and stays above the message box', async () => {
  const w = graft.window;
  provider.script(
    { toolCalls: [{ name: 'ExitPlanMode', input: { plan: '## Add a greeting\n\n1. Create hello.txt' } }] },
    { text: 'Following your version.' }
  );
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('/plan add a greeting file');
  await composer.press('Enter');
  const card = w.getByRole('alertdialog', { name: 'Approve this plan?' });
  await card.getByRole('button', { name: 'Edit plan' }).click();
  const box = card.getByRole('textbox', { name: 'Plan' });
  await box.fill('');
  await expect(card.getByRole('button', { name: 'Approve plan' })).toBeDisabled();
  await box.fill('## Add a greeting\n\n1. Create hello.txt\n2. Say hello in Norwegian too');
  await card.getByRole('button', { name: 'Approve plan' }).click();
  await expect(w.getByText('Following your version.')).toBeVisible();
  const told = JSON.stringify(provider.chatRequests()[1]!.body);
  expect(told).toContain('carry out their version');
  expect(told).toContain('Say hello in Norwegian too');
  await w.getByRole('button', { name: /^Plan: Add a greeting/ }).click();
  const dialog = w.getByRole('dialog', { name: 'Plan' });
  await expect(dialog.getByText('Say hello in Norwegian too')).toBeVisible();
});
```

- [ ] **Step 2: Refresh the model list, bump the version, write the notes**

Run `npm run catalog`. Set `0.6.11` in `package.json` and both root entries of `package-lock.json`. Add at the top of `releaseNotes.json`:

```json
{
  "version": "0.6.11",
  "date": "YYYY-MM-DD",
  "items": [
    "Edit a plan before you approve it. The approval card has Edit plan: change the steps, and the agent follows your version.",
    "The plan stays. Once approved it sits above the message box with how many tasks are done, opens with a click, and is repeated word for word when a long conversation is compacted.",
    "/plan and what you want planned switches to Plan mode and asks for a plan. Plans now come as a goal, steps with the files they touch, the checks that will prove it, and the risks; when a request leaves a real choice open, the agent asks first."
  ]
}
```

In `README.md`, update the Permission modes bullet and the command list. In `docs/PRODUCT_ROADMAP.md`, add `### 0.6.11` under Completed, and under weaknesses: a session has one current plan, and a plan is not saved as a file in the project.

- [ ] **Step 3: Verify the whole round**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: no errors; every unit test passes.
Run: `docker desktop start`, then `npm run test:e2e:docker` (if the script is missing, create it from spec section 6), then `docker desktop stop`
Expected: `0 failed`. Report the exact counts.

- [ ] **Step 4: Commit (only when the owner has asked for commits)**

```bash
git add -A
git commit -m "chore: 0.6.11 notes and the plan end-to-end test"
```
