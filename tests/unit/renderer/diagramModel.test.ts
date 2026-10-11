import { describe, expect, it } from 'vitest';
import { fitScale, frameWidth, madeDiagrams, nextZoom, previewProblem, sizeFromMessage } from '../../../src/renderer/src/features/session/diagramModel';
import { groupActivity, type ToolCall, type TranscriptItem } from '../../../src/renderer/src/features/session/transcriptModel';

const edit = (id: string, path: string, diagram?: { title: string; width: number; height: number }, isError = false): ToolCall => ({
  id,
  name: 'Write',
  input: {},
  running: null,
  result: { type: 'tool_result', toolUseId: id, isError, content: [], display: { kind: 'edit', path, created: true, patch: '', added: 1, removed: 0, ...(diagram ? { diagram } : {}) } }
});

describe('the diagrams of a turn', () => {
  it('are one per file, first written first, as last written', () => {
    const calls = [
      edit('1', 'docs/diagrams/a.html', { title: 'A', width: 960, height: 600 }),
      edit('2', 'src/x.ts'),
      edit('3', 'docs/diagrams/b.html', { title: 'B', width: 1200, height: 640 }),
      edit('4', 'docs/diagrams/a.html', { title: 'A, again', width: 1000, height: 500 }),
      edit('5', 'docs/diagrams/c.html', { title: 'C', width: 960, height: 600 }, true)
    ];
    expect(madeDiagrams(calls)).toEqual([
      { source: { kind: 'project', path: 'docs/diagrams/a.html' }, name: 'a.html', title: 'A, again', width: 1000, height: 500 },
      { source: { kind: 'project', path: 'docs/diagrams/b.html' }, name: 'b.html', title: 'B', width: 1200, height: 640 }
    ]);
  });

  it('are not a page that stopped being a diagram', () => {
    expect(madeDiagrams([edit('1', 'a.html', { title: 'A', width: 960, height: 600 }), edit('2', 'a.html')])).toEqual([]);
  });

  it('include the diagrams a chat made as files', () => {
    const made = (id: string, name: string, diagram?: { title: string; width: number; height: number }, isError = false): ToolCall => ({
      id,
      name: 'CreateFile',
      input: {},
      running: null,
      result: { type: 'tool_result', toolUseId: id, isError, content: [], display: { kind: 'file', name, size: 10, mime: 'text/html', preview: null, ...(diagram ? { diagram } : {}) } }
    });
    const calls = [
      made('1', 'orders.html', { title: 'Orders', width: 960, height: 600 }),
      made('2', 'notes.md'),
      made('3', 'orders (2).html', { title: 'Orders, wider', width: 1200, height: 600 }),
      made('4', 'failed.html', { title: 'Failed', width: 960, height: 600 }, true)
    ];
    expect(madeDiagrams(calls)).toEqual([
      { source: { kind: 'chat', name: 'orders.html' }, name: 'orders.html', title: 'Orders', width: 960, height: 600 },
      { source: { kind: 'chat', name: 'orders (2).html' }, name: 'orders (2).html', title: 'Orders, wider', width: 1200, height: 600 }
    ]);
    // The files are still listed; the diagrams are drawn after them.
    const items: TranscriptItem[] = [{ kind: 'tools', key: 't1', calls, at: 1 }];
    expect(groupActivity(items, false, 'normal').map((i) => i.kind)).toEqual(['activity', 'files', 'diagrams']);
  });

  it('end a finished turn as a card after its files, and not a running one', () => {
    const items: TranscriptItem[] = [{ kind: 'tools', key: 't1', calls: [edit('1', 'a.html', { title: 'A', width: 960, height: 600 })], at: 1 }];
    expect(groupActivity(items, false, 'normal').map((i) => i.kind)).toEqual(['activity', 'edits', 'diagrams']);
    expect(groupActivity(items, true, 'normal').map((i) => i.kind)).toEqual(['activity']);
  });
});

describe('fitting a diagram', () => {
  it('gives the page the width it wants', () => {
    expect(frameWidth(960)).toBe(1024);
    expect(frameWidth(300)).toBe(640);
  });

  it('scales down to the card and to 520 px, and never up', () => {
    expect(fitScale({ width: 1024, height: 800 }, { width: 700, maxHeight: 520 })).toBeCloseTo(0.65, 5);
    expect(fitScale({ width: 1024, height: 400 }, { width: 700, maxHeight: 520 })).toBeCloseTo(700 / 1024, 5);
    expect(fitScale({ width: 640, height: 300 }, { width: 700, maxHeight: 520 })).toBe(1);
    expect(fitScale({ width: 8064, height: 400 }, { width: 700, maxHeight: 520 }) * 8064).toBeLessThanOrEqual(700);
  });

  it('takes a size report only when it is one', () => {
    expect(sizeFromMessage({ graftPreview: { width: 1024, height: 731.5 } })).toEqual({ width: 1024, height: 732 });
    expect(sizeFromMessage({ graftPreview: { width: 5, height: 1e9 } })).toEqual({ width: 100, height: 20000 });
    for (const bad of [null, 'x', {}, { graftPreview: null }, { graftPreview: { width: '1', height: 2 } }, { graftPreview: { width: NaN, height: 2 } }, { graftPreview: { width: Infinity, height: 2 } }]) {
      expect(sizeFromMessage(bad)).toBeNull();
    }
  });

  it('says why a diagram cannot be shown', () => {
    expect(previewProblem({ code: 'not_found', message: 'a.html was moved or deleted.' })).toBe('This file was moved or deleted.');
    expect(previewProblem({ code: 'not_a_diagram', message: "Couldn't find the diagram in a.html." })).toBe("Couldn't find the diagram in a.html.");
    expect(previewProblem(new Error('The folder is gone.'))).toBe('The folder is gone.');
    expect(previewProblem('nope')).toBe('nope');
  });

  it('steps through the zoom levels from wherever it is', () => {
    expect(nextZoom('fit', 0.6, 1)).toBe(0.75);
    expect(nextZoom('fit', 0.6, -1)).toBe(0.5);
    expect(nextZoom(2, 0.6, 1)).toBe(2);
    expect(nextZoom(0.5, 0.6, -1)).toBe(0.5);
    expect(nextZoom(1, 0.6, 1)).toBe(1.5);
  });
});
