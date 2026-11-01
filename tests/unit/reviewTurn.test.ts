import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REVIEW_READ_ONLY } from '../../src/main/agent/reviewScope';
import { fakeModel } from '../support/fakeProvider';
import { makeRepo } from '../support/gitRepo';
import { makeHarness, type Harness } from '../support/sessionHarness';
import { removeDir, writeFile } from '../support/tmp';

let harnesses: Harness[] = [];
function harness(...args: Parameters<typeof makeHarness>): Harness {
  const h = makeHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses) {
    await h.session.dispose();
    removeDir(h.projectDir);
    removeDir(h.home);
  }
  harnesses = [];
});

const finding = { path: 'src/a.ts', line: 1, severity: 'high', title: 'Wrong total', detail: 'An empty cart totals 1.' };

describe('/review as a turn', () => {
  it('runs read-only on the reviewer model and keeps the findings with the turn', async () => {
    const main = fakeModel();
    const reviewer = fakeModel({ ref: { providerId: 'fake', modelId: 'reviewer-model' }, label: 'Reviewer Model' });
    const h = harness({
      projectDir: makeRepo({ 'src/a.ts': 'export const total = 0;\n' }),
      // Bypass would run anything without asking: a review is read-only all the same.
      mode: 'bypass',
      bypassEnabled: true,
      models: [main, reviewer],
      agents: { roles: { reviewer: reviewer.ref } },
      script: [
        { toolCalls: [{ name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'total = 1', new_string: 'total = 2' } }] },
        { toolCalls: [{ name: 'Shell', input: { command: 'git commit -am sneaky', description: 'commit' } }] },
        { toolCalls: [{ name: 'ReportFindings', input: { findings: [finding], summary: 'Looked at the cart.' } }] },
        { text: 'One problem.' },
        { text: 'Hello again.' }
      ]
    });
    writeFile(h.projectDir, 'src/a.ts', 'export const total = 1;\n');
    await h.turn('/review the cart');

    expect(h.events.some((e) => e.type === 'permission')).toBe(false);
    expect(fs.readFileSync(path.join(h.projectDir, 'src/a.ts'), 'utf8')).toBe('export const total = 1;\n');
    const requests = h.provider.requests;
    expect(requests.slice(0, 4).map((r) => r.model.ref.modelId)).toEqual(['reviewer-model', 'reviewer-model', 'reviewer-model', 'reviewer-model']);
    const asked = JSON.stringify(requests[0]!.messages.at(-1));
    expect(asked).toContain('Review the uncommitted changes in this repository.');
    expect(asked).toContain('Focus especially on: the cart');
    expect(requests[0]!.tools.map((t) => t.name)).toContain('ReportFindings');
    // The edit and the commit are refused with the review's own sentence, without asking.
    expect(JSON.stringify(requests[1]!.messages.at(-1))).toContain(REVIEW_READ_ONLY);
    expect(JSON.stringify(requests[2]!.messages.at(-1))).toContain(REVIEW_READ_ONLY);

    const messages = h.store.listMessages('session-1');
    expect(messages.find((m) => m.role === 'user' && m.meta.typed)?.meta.typed).toBe('/review the cart');
    const display = messages.flatMap((m) => m.content).flatMap((b) => (b.type === 'tool_result' && b.display?.kind === 'findings' ? [b.display] : []));
    expect(display).toEqual([{ kind: 'findings', summary: 'Looked at the cart.', findings: [{ ...finding, endLine: 1, suggestion: null }] }]);

    // The next message is an ordinary turn again: the session's model, and its mode as it was.
    await h.turn('hello');
    expect(requests.at(-1)!.model.ref.modelId).toBe('fake-model');
    expect(h.session.summary.permissionMode).toBe('bypass');
  });

  it('says why there is nothing to review without asking a model', async () => {
    const h = harness({ projectDir: makeRepo(), script: [{ text: 'never sent' }] });
    await h.turn('/review');
    await h.turn('/security-review pr');
    expect(h.provider.requests).toHaveLength(0);
    const said = h.store.listMessages('session-1').filter((m) => m.meta.kind === 'command-output').map((m) => (m.content[0]?.type === 'text' ? m.content[0].text : ''));
    expect(said).toEqual(['There are no uncommitted changes to review. For work that is committed, use /review branch or /review <commit>.', 'Say which pull request to review by its number, for example /review pr 12.']);
  });

  it('keeps the session model when no model is set for reviews', async () => {
    const h = harness({ projectDir: makeRepo({ 'a.txt': 'one\n' }), script: [{ toolCalls: [{ name: 'ReportFindings', input: { findings: [] } }] }, { text: 'Nothing found.' }] });
    writeFile(h.projectDir, 'a.txt', 'two\n');
    await h.turn('/security-review');
    expect(h.provider.requests.map((r) => r.model.ref.modelId)).toEqual(['fake-model', 'fake-model']);
    expect(JSON.stringify(h.provider.requests[0]!.messages.at(-1))).toContain('Do a security review of the uncommitted changes');
  });
});
