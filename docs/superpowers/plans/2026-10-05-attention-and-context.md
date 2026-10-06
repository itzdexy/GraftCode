# Attention and Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user sees what needs them and where the context goes: a `Needs you` section in the sidebar, `/context` and a breakdown in the context popover, and a switch for notification sounds. Ships as 0.6.13.

**Architecture:** The breakdown is a pure estimate over what the next request would send (`src/main/agent/contextBreakdown.ts`), reached through one new IPC channel and one slash command. The sidebar section is one more pure list function beside the existing ones. The sound switch is a new settings field read where the notification is built.

**Tech Stack:** TypeScript, Zod, React 18, Radix popover, Electron `Notification`, Vitest 5, Playwright. No new packages.

**Spec:** `docs/superpowers/specs/2026-10-05-next-rounds-design.md`, section 4.5. Product spec: `docs/SPEC.md`.

## Global Constraints

- Build on what is there: the context ring, its popover with `Compact now`, the sidebar's filter and the notification switches keep their behaviour.
- Show only measured or clearly labelled numbers: the parts are estimates from the text and say so; the provider's own count is shown beside them when there is one.
- Working out the breakdown never changes a session: no prompt is rebuilt and kept, no model is called.
- Stored data changes only by adding: `notifications.sound` with the default `true` in `DEFAULT_APP_SETTINGS`.
- The new IPC channel has Zod schemas for its input and output in `src/shared/ipc/contracts.ts`.
- Exact copy (part names, `/context` lines, popover texts, the section's name, the switch) is in spec 4.5; use it word for word.
- Tests first. Unit tests in `tests/unit/**`; renderer logic as pure functions in `tests/unit/renderer/**`.
- Interface: existing tokens and components; the section and the bars have accessible names; nothing overflows at 900x600.
- No commits unless the owner has asked; each task gives the message for when they do.

## Review Focus

1. A session that has sent nothing yet, or a model whose window is unknown (`limit` 0): the breakdown says so and never divides by zero (Task 1 test).
2. MCP tools that wait to be loaded: only loaded tools are counted, because only they are sent (Task 1 test).
3. An archived session that still waits for an answer: it is not under `Needs you` (Task 3 test).
4. A filter is on (Archived, Running): the section is hidden, so the list shows only what was asked for (Task 3 test).
5. Sound switched off: errors and questions are silent too, and the sample notification follows the switch (Task 4 test).

---

### Task 1: What fills the context

**Files:**
- Create: `src/main/agent/contextBreakdown.ts`
- Modify: `src/shared/schemas/sessions.ts` (`ContextPartSchema`, `ContextReportSchema`), `src/shared/ipc/contracts.ts` (`sessions:context`), `src/main/agent/session.ts` (`contextReport`), `src/main/agent/sessionManager.ts` (`contextReport(id)`), `src/main/ipc/handlers.ts`
- Test: `tests/unit/contextBreakdown.test.ts`, `tests/unit/agent.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // sessions.ts
  export const ContextPartSchema = z.object({ id: z.enum(['system', 'tools', 'mcp', 'user', 'replies', 'results', 'reasoning']), label: z.string(), tokens: z.number().int().nonnegative() });
  export const ContextReportSchema = z.object({ parts: z.array(ContextPartSchema), measured: z.number().int().nonnegative().nullable(), limit: z.number().int().nonnegative() });
  export type ContextPart = z.infer<typeof ContextPartSchema>;
  export type ContextReport = z.infer<typeof ContextReportSchema>;
  // contextBreakdown.ts
  export function contextBreakdown(input: { system: string; tools: ToolSpec[]; messages: LlmMessage[] }): ContextPart[];   // largest first, empty parts left out
  export function contextLines(report: ContextReport): string[];
  // session.ts
  contextReport(): Promise<ContextReport>;
  // contracts.ts
  'sessions:context': channel(z.object({ id: IdSchema }), ContextReportSchema)
  ```

- [ ] **Step 1: Write the failing tests**

`tests/unit/contextBreakdown.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { contextBreakdown, contextLines } from '../../src/main/agent/contextBreakdown';

describe('what fills the context', () => {
  it('splits what would be sent into parts, largest first, without the empty ones', () => {
    const parts = contextBreakdown({
      system: 's'.repeat(3500),
      tools: [
        { name: 'Read', description: 'd'.repeat(2090), inputSchema: {} },
        { name: 'mcp__gh__create_issue', description: 'd'.repeat(1390), inputSchema: {} }
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'u'.repeat(350) }] },
        { role: 'assistant', content: [{ type: 'thinking', text: 't'.repeat(700), display: 'summary' }, { type: 'text', text: 'a'.repeat(1050) }, { type: 'tool_use', id: 'x', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'x', isError: false, content: [{ type: 'text', text: 'r'.repeat(7000) }, { type: 'image', mediaType: 'image/png', data: 'AA' }] }] }
      ]
    });
    expect(parts.map((p) => [p.id, p.label])).toEqual([
      ['results', 'Tool results'],
      ['system', 'System prompt'],
      ['tools', 'Built-in tools'],
      ['mcp', 'MCP tools'],
      ['replies', 'Replies'],
      ['reasoning', 'Reasoning'],
      ['user', 'Your messages']
    ]);
    const tokens = Object.fromEntries(parts.map((p) => [p.id, p.tokens]));
    expect(tokens).toMatchObject({ results: 3600, system: 1000, replies: 311, reasoning: 200, user: 100 });
    expect(tokens.tools).toBeGreaterThan(600);
    expect(tokens.mcp).toBeGreaterThan(400);
    expect(contextBreakdown({ system: 's'.repeat(35), tools: [], messages: [] })).toEqual([{ id: 'system', label: 'System prompt', tokens: 10 }]);
  });

  it('writes the lines /context prints', () => {
    const parts = [
      { id: 'results' as const, label: 'Tool results', tokens: 22_100 },
      { id: 'system' as const, label: 'System prompt', tokens: 6_300 }
    ];
    expect(contextLines({ parts, measured: 43_812, limit: 200_000 })).toEqual([
      'Context: about 28,400 of 200,000 tokens (14%).',
      '- Tool results: 22,100',
      '- System prompt: 6,300',
      'Estimated from the text; the provider counted 43,812.'
    ]);
    expect(contextLines({ parts, measured: null, limit: 0 })).toEqual(['Context: about 28,400 tokens (window size unknown).', '- Tool results: 22,100', '- System prompt: 6,300', 'Estimated from the text.']);
  });
});
```

In `tests/unit/agent.test.ts`:

```ts
it('reports what the next request would hold without sending anything or changing the session', async () => {
  const h = harness({
    model: { contextWindow: 20_000 },
    mcpTools: Array.from({ length: 12 }, (_, i) => ({ ...testTool(`mcp__crm__record_${String(i)}`, { safe: true }), description: 'It works on the connected service. '.repeat(20), mcp: { server: 'crm', tool: `record_${String(i)}`, readOnly: true, destructive: false } })),
    script: [{ text: 'Hello there!', usage: { inputTokens: 1000, outputTokens: 50 } }]
  });
  h.session.send('hi');
  await h.session.idle();
  const report = await h.session.contextReport();
  expect(report).toMatchObject({ measured: 1050, limit: 20_000 });
  expect(report.parts.map((p) => p.id)).toEqual(expect.arrayContaining(['system', 'tools', 'user', 'replies']));
  // The twelve MCP tools wait to be loaded (they weigh more than a tenth of this window), so none is counted.
  expect(report.parts.some((p) => p.id === 'mcp')).toBe(false);
  expect(h.provider.requests).toHaveLength(1);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/contextBreakdown.test.ts tests/unit/agent.test.ts -t "context|next request"`
Expected: FAIL, cannot find `contextBreakdown`; `contextReport` is not a function.

- [ ] **Step 3: Write the breakdown, the report and the channel**

`contextBreakdown` uses `estimateTextTokens` and `IMAGE_TOKENS` from `tokens.ts` (export it if the long-sessions plan has not): the system text is `system`; a tool is `estimateTextTokens(JSON.stringify(spec))`, under `mcp` when its name starts with `mcp__` and `tools` otherwise; text and pictures of user messages are `user`; text of assistant messages, and each `tool_use` as `estimateTextTokens(JSON.stringify(input ?? {})) + 10`, are `replies`; thinking is `reasoning`; a tool result's text and pictures are `results`. `contextLines` formats numbers with `toLocaleString('en-US')` and rounds the percentage. `Session.contextReport()` takes `{ system, tools }` from the existing `promptPreview()`, the specs from `this.deps.tools.specs(tools)`, the messages from `this.history()`, `measured` from `summary.usage.contextTokens` (null when 0) and `limit` from the resolved model's `contextWindow`. The manager and the handler pass it through.

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run tests/unit/contextBreakdown.test.ts tests/unit/agent.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src/main src/shared tests/unit/contextBreakdown.test.ts tests/unit/agent.test.ts
git commit -m "feat(context): work out what fills the context"
```

---

### Task 2: `/context`, and the breakdown in the popover

**Files:**
- Create: `src/renderer/src/features/composer/contextModel.ts`
- Modify: `src/main/agent/slashCommands.ts` (`BUILTIN_COMMANDS`), `src/main/agent/session.ts` (`handleSlash`), `src/renderer/src/features/composer/ContextUsage.tsx`, `src/renderer/src/features/session/SessionView.tsx` (passes the loader)
- Test: `tests/unit/agent.test.ts`, `tests/unit/renderer/rendererLogic.test.ts`

**Interfaces:**
- Consumes: `contextLines`, `Session.contextReport`, `ContextPart`, `ContextReport`, `sessions:context` (Task 1).
- Produces:
  ```ts
  // contextModel.ts
  export function partBars(parts: ContextPart[]): Array<{ id: string; label: string; tokens: string; share: number }>;   // share: 0..1 of the largest part
  // ContextUsage props
  loadParts?: () => Promise<ContextReport>;
  ```
  and the command `{ name: 'context', description: 'Show what fills the context window', argumentHint: null }`, listed after `cost`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/agent.test.ts`, inside `describe('commands, memory and history')`:

```ts
it('/context prints what fills the window, without asking the model', async () => {
  const h = harness({ script: [{ text: 'Hello there!', usage: { inputTokens: 1000, outputTokens: 50 } }] });
  h.session.send('hi');
  await h.session.idle();
  h.session.send('/context');
  await h.session.idle();
  const printed = texts(h).at(-1) ?? '';
  expect(printed).toMatch(/^assistant:Context: about [\d,]+ of 100,000 tokens \(\d+%\)\.\n- /);
  expect(printed).toMatch(/- System prompt: [\d,]+/);
  expect(printed).toMatch(/- Built-in tools: [\d,]+/);
  expect(printed.endsWith('Estimated from the text; the provider counted 1,050.')).toBe(true);
  expect(h.provider.requests).toHaveLength(1);
});
```

In `tests/unit/renderer/rendererLogic.test.ts`, inside `describe('context and spend')`:

```ts
it('draws each part against the largest', () => {
  expect(partBars([{ id: 'results', label: 'Tool results', tokens: 22_100 }, { id: 'system', label: 'System prompt', tokens: 5_525 }])).toEqual([
    { id: 'results', label: 'Tool results', tokens: '22K', share: 1 },
    { id: 'system', label: 'System prompt', tokens: '5.5K', share: 0.25 }
  ]);
  expect(partBars([])).toEqual([]);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/agent.test.ts tests/unit/renderer/rendererLogic.test.ts -t "context|draws each part"`
Expected: FAIL (`/context` is sent to the model; `partBars` does not exist).

- [ ] **Step 3: Add the command and the popover section**

`case 'context'` in `handleSlash` prints `contextLines(await this.contextReport()).join('\n')` with `commandOutput`. `partBars` formats tokens with the existing `formatTokenCount` and rounds `share` to two decimals. In `ContextUsage`, when `loadParts` is given: the popover calls it each time it opens and, between the usage bar and `This session`, shows `What fills it` with one row a part (label, tokens, a track of `bg-control` with a `bg-blue` fill whose width is `share`), `Working it out…` while loading, `Couldn't work it out.` on failure, and `Estimated from the text.` under the rows. Each row is a `div` with `role="img"` and `aria-label` of `<label>: <tokens> tokens`. `SessionView` passes `loadParts={() => invoke('sessions:context', { id: summary.id })}`.

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run tests/unit/agent.test.ts tests/unit/renderer && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src tests
git commit -m "feat(context): /context and a breakdown in the context popover"
```

---

### Task 3: `Needs you` in the sidebar

**Files:**
- Modify: `src/renderer/src/features/shell/sessionLists.ts`, `src/renderer/src/features/shell/Sidebar.tsx`
- Test: `tests/unit/renderer/rendererLogic.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Sessions waiting for an answer or an approval, or stopped with an error: not archived, newest first. Empty while a filter is on. */
  export function needsYou(all: SessionSummary[], kind: SessionKind, filter: SessionFilter): SessionSummary[];
  /** `sessions` without the ones listed under Needs you. */
  export function withoutThose(sessions: SessionSummary[], listed: SessionSummary[]): SessionSummary[];
  ```

- [ ] **Step 1: Write the failing test**

Inside `describe('session lists')`:

```ts
it('lists what needs the user first, once, and not while a filter is on', () => {
  const all = [
    session({ id: 'ask', status: 'needs-input', updatedAt: NOW - 3000 }),
    session({ id: 'err', status: 'error', updatedAt: NOW - 1000 }),
    session({ id: 'run', status: 'running' }),
    session({ id: 'unread', unread: true }),
    session({ id: 'old', status: 'needs-input', archived: true }),
    session({ id: 'chat', kind: 'chat', status: 'needs-input' })
  ];
  const needing = needsYou(all, 'code', DEFAULT_FILTER);
  expect(needing.map((s) => s.id)).toEqual(['err', 'ask']);
  expect(needsYou(all, 'chat', DEFAULT_FILTER).map((s) => s.id)).toEqual(['chat']);
  expect(withoutThose(visibleSessions(all, 'code', DEFAULT_FILTER, NOW), needing).map((s) => s.id).sort()).toEqual(['run', 'unread']);
  expect(needsYou(all, 'code', { ...DEFAULT_FILTER, status: 'archived' })).toEqual([]);
  expect(needsYou(all, 'code', { ...DEFAULT_FILTER, status: 'running' })).toEqual([]);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/unit/renderer/rendererLogic.test.ts -t "needs the user"`
Expected: FAIL, `needsYou` is not exported.

- [ ] **Step 3: Write the two functions and render the section**

`needsYou` returns `[]` when `filterActive(filter)`. In `Sidebar.tsx`, the chat list and the code list both compute `needing` and render, above their other sections and only when it is not empty, `<section aria-label="Needs you">` with `ListHeader label="Needs you"` and a `SessionRow` for each; the lists below get `withoutThose(sessions, needing)`. An empty project group left by that is not rendered.

- [ ] **Step 4: Run the tests and the renderer type check**

Run: `npx vitest run tests/unit/renderer && npx tsc -p tsconfig.web.json --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src/renderer/src/features/shell tests/unit/renderer/rendererLogic.test.ts
git commit -m "feat(sidebar): list what needs you at the top"
```

---

### Task 4: A switch for the sound

**Files:**
- Modify: `src/shared/schemas/appSettings.ts` (`notifications.sound`, its default), `src/main/app/notifications.ts`, `src/main/ipc/handlers.ts` (the `notifications:test` handler), `src/renderer/src/features/settings/NotificationsSection.tsx`
- Test: `tests/unit/privacy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // appSettings.ts, in `notifications`
  sound: z.boolean()                    // DEFAULT_APP_SETTINGS.notifications.sound = true
  // notifications.ts
  export function notificationPlan(settings: AppSettings['notifications'], kind: NotifyKind): { show: boolean; silent: boolean };
  ```

- [ ] **Step 1: Write the failing test**

Beside the existing `notificationContent` test:

```ts
it('is silent for a finished session, and for everything when the sound is off', () => {
  const on = DEFAULT_APP_SETTINGS.notifications;
  expect(on.sound).toBe(true);
  expect(notificationPlan(on, 'needs-input')).toEqual({ show: true, silent: false });
  expect(notificationPlan(on, 'error')).toEqual({ show: true, silent: false });
  expect(notificationPlan(on, 'finished')).toEqual({ show: true, silent: true });
  expect(notificationPlan({ ...on, sound: false }, 'needs-input')).toEqual({ show: true, silent: true });
  expect(notificationPlan({ ...on, sound: false }, 'error')).toEqual({ show: true, silent: true });
  expect(notificationPlan({ ...on, enabled: false }, 'error').show).toBe(false);
  expect(notificationPlan({ ...on, needsInput: false }, 'needs-input').show).toBe(false);
  // An install from before the switch keeps its choices and gets the sound on.
  expect(AppSettingsSchema.shape.notifications.parse({ ...on, enabled: true, needsInput: false, finished: true, errors: true })).toMatchObject({ needsInput: false, sound: true });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run tests/unit/privacy.test.ts -t "silent"`
Expected: FAIL, `notificationPlan` is not exported.

- [ ] **Step 3: Add the field, the function and the switch**

`showSessionNotification` uses `notificationPlan` for its two decisions (it still shows nothing while the session is visible or notifications are unsupported). The `notifications:test` handler passes `silent: !settings.notifications.sound`. In `NotificationsSection`, after the error switch: a `SwitchRow` with the label and description of spec 4.5, disabled while notifications are off.

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run tests/unit/privacy.test.ts tests/unit/system.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src tests/unit/privacy.test.ts
git commit -m "feat(notifications): a switch for the sound"
```

---

### Task 5: Release 0.6.13

**Files:**
- Modify: `tests/e2e/session.spec.ts`, `package.json`, `package-lock.json`, `src/renderer/src/features/home/releaseNotes.json`, `README.md`, `docs/PRODUCT_ROADMAP.md`, `resources/catalog/models.json` (by `npm run catalog`)

- [ ] **Step 1: Write the end-to-end test**

```ts
test('what fills the context is shown, and a session that waits is listed under Needs you', async () => {
  const w = graft.window;
  provider.script({ text: 'Hi.' }, { toolCalls: [{ name: 'Write', input: { file_path: 'x.txt', content: 'x' } }] });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('hello');
  await composer.press('Enter');
  await expect(w.getByText('Hi.', { exact: true })).toBeVisible();

  const box = w.getByRole('combobox', { name: SESSION_BOX }).or(w.getByRole('textbox', { name: SESSION_BOX }));
  await box.fill('/context');
  await box.press('Enter');
  await expect(w.getByText(/Context: about [\d,]+ of [\d,]+ tokens/)).toBeVisible();
  await expect(w.getByText(/System prompt: [\d,]+/)).toBeVisible();
  expect(provider.chatRequests()).toHaveLength(1);

  await w.getByRole('button', { name: /^Context:/ }).click();
  await expect(w.getByText('What fills it')).toBeVisible();
  await expect(w.getByRole('img', { name: /^System prompt: .* tokens$/ })).toBeVisible();
  await w.keyboard.press('Escape');

  await expect(w.getByRole('region', { name: 'Needs you' })).toHaveCount(0);
  await box.fill('write a file');
  await box.press('Enter');
  await expect(w.getByRole('alertdialog')).toBeVisible();
  await expect(w.getByRole('region', { name: 'Needs you' })).toBeVisible();
});
```

- [ ] **Step 2: Refresh the model list, bump the version, write the notes**

Run `npm run catalog`. Set `0.6.13` in `package.json` and both root entries of `package-lock.json`. Add at the top of `releaseNotes.json`:

```json
{
  "version": "0.6.13",
  "date": "YYYY-MM-DD",
  "items": [
    "Needs you: sessions that wait for an answer or an approval, or stopped with an error, are listed at the top of the sidebar.",
    "See what fills the context. Type /context, or click the context ring: the system prompt, tools, your messages, replies, tool results and reasoning, each with its size. They are estimates from the text, shown next to the provider's own count.",
    "Notifications have a sound switch (Settings → Notifications). A finished session stays quiet either way."
  ]
}
```

In `README.md`, mention the section, `/context` and the switch where sessions, commands and notifications are described. In `docs/PRODUCT_ROADMAP.md`, add `### 0.6.13` under Completed; mark "Where the context and the money went" as shipped for the context half (money by day is still open); note under weaknesses that the parts are estimates.

- [ ] **Step 3: Verify the whole round**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: no errors; every unit test passes.
Run: `docker desktop start`, then `npm run test:e2e:docker` (if the script is missing, create it from spec section 6), then `docker desktop stop`
Expected: `0 failed`. Report the exact counts.

- [ ] **Step 4: Commit (only when the owner has asked for commits)**

```bash
git add -A
git commit -m "chore: 0.6.13 notes and the end-to-end test for context and Needs you"
```
