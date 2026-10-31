import { describe, expect, it } from 'vitest';
import type { Finding } from '../../../src/shared/schemas/findings';
import type { ContentBlock, StoredMessage } from '../../../src/shared/schemas/messages';
import { findingComment, findingGroups, findingKey, findingPlace, severityTally } from '../../../src/renderer/src/features/review/findingsModel';
import { commentLine } from '../../../src/renderer/src/features/review/reviewModel';
import { buildTranscript, editedFiles, groupActivity } from '../../../src/renderer/src/features/session/transcriptModel';

const f = (over: Partial<Finding> = {}): Finding => ({ path: 'src/a.ts', line: 4, endLine: 4, severity: 'medium', title: 'Off by one.', detail: 'The last item is skipped.', suggestion: null, ...over });

let seq = 0;
function msg(role: 'user' | 'assistant', content: ContentBlock[], meta: StoredMessage['meta'] = {}): StoredMessage {
  seq++;
  return { id: `m${String(seq)}`, sessionId: 's', seq, role, content, meta, createdAt: seq };
}

describe('the findings card', () => {
  it('groups findings by file, each file where its worst finding is', () => {
    const findings = [f({ severity: 'high', path: 'src/b.ts' }), f({ severity: 'high', path: 'src/a.ts', line: 9 }), f({ path: 'src/b.ts', line: 2 }), f({ severity: 'low' })];
    const groups = findingGroups('s1', 'call-1', findings);
    expect(groups.map((g) => [g.path, g.items.map((i) => i.key)])).toEqual([
      ['src/b.ts', ['s1:call-1:0', 's1:call-1:2']],
      ['src/a.ts', ['s1:call-1:1', 's1:call-1:3']]
    ]);
    expect(findingKey('s1', 'call-1', 3)).toBe('s1:call-1:3');
    expect(severityTally(findings)).toEqual([
      { severity: 'high', count: 2 },
      { severity: 'medium', count: 1 },
      { severity: 'low', count: 1 }
    ]);
    expect(severityTally([f()])).toEqual([{ severity: 'medium', count: 1 }]);
  });

  it('names the place of one line or several', () => {
    expect(findingPlace(f())).toBe('src/a.ts:4');
    expect(findingPlace(f({ line: 4, endLine: 9 }))).toBe('src/a.ts:4-9');
  });

  it('turns a finding into a comment on its lines for the next message', () => {
    const comment = findingComment(f({ severity: 'high', line: 4, endLine: 6, suggestion: 'Loop to the length.' }));
    expect(comment).toEqual({
      path: 'src/a.ts',
      line: 4,
      endLine: 6,
      side: 'new',
      quote: '',
      text: 'Fix this high-severity finding: Off by one. The last item is skipped. Suggested fix: Loop to the length.'
    });
    expect(commentLine({ ...comment, id: 'x', at: 1 })).toBe('- src/a.ts:4-6 — Fix this high-severity finding: Off by one. The last item is skipped. Suggested fix: Loop to the length.');
    expect(findingComment(f()).text).toBe('Fix this medium-severity finding: Off by one. The last item is skipped.');
  });
});

describe('findings in the transcript', () => {
  it('stand as their own item and pick up what the tool kept, or why it refused', () => {
    const display = { kind: 'findings' as const, findings: [f()], summary: 'Checked the loop.' };
    const items = buildTranscript(
      [
        msg('user', [{ type: 'text', text: 'review' }], { typed: '/review' }),
        msg('assistant', [{ type: 'tool_use', id: 'r1', name: 'ReportFindings', input: { findings: [] } }]),
        msg('user', [{ type: 'tool_result', toolUseId: 'r1', content: [], isError: true, display: { kind: 'error', message: 'Not a file of the project.' } }]),
        msg('assistant', [{ type: 'tool_use', id: 'r2', name: 'ReportFindings', input: { findings: [] } }]),
        msg('user', [{ type: 'tool_result', toolUseId: 'r2', content: [], isError: false, display }]),
        msg('assistant', [{ type: 'text', text: 'One problem.' }])
      ],
      { streaming: null, running: {} }
    );
    expect(items.map((i) => i.kind)).toEqual(['user', 'findings', 'findings', 'text']);
    expect(items[1]).toMatchObject({ kind: 'findings', callId: 'r1', display: null, error: 'Not a file of the project.' });
    expect(items[2]).toMatchObject({ kind: 'findings', callId: 'r2', display, error: null });
    // Folded into a summary, the card still stands on its own.
    expect(groupActivity(items, false, 'summary').map((i) => i.kind)).toEqual(['user', 'findings', 'findings', 'text']);
  });

  it('keeps the call behind each patch of an edited file, for undoing one change of it', () => {
    const edit = (id: string, patch: string) => ({
      id,
      name: 'Edit',
      input: {},
      result: { type: 'tool_result' as const, toolUseId: id, content: [], isError: false, display: { kind: 'edit' as const, path: 'a.ts', created: false, patch, added: 1, removed: 1 } },
      running: null
    });
    const files = editedFiles([edit('e1', 'p1'), edit('e2', ''), edit('e3', 'p3')]);
    expect(files).toEqual([{ path: 'a.ts', added: 3, removed: 3, created: false, patches: ['p1', 'p3'], calls: ['e1', 'e3'] }]);
  });
});
