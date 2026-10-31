import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeFindings, ReportFindingsInput, reportFindingsTool, severityCounts } from '../../src/main/tools/reportFindings';
import { createBuiltinRegistry, PARENT_ONLY_TOOLS } from '../../src/main/tools/builtin';
import { resolveRole } from '../../src/main/agent/roles';
import { makeTempDir, removeDir } from '../support/tmp';
import { makeToolContext } from '../support/toolContext';

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  removeDir(dir);
});

const finding = (over: Partial<ReportFindingsInput['findings'][number]> = {}): ReportFindingsInput['findings'][number] => ({
  path: 'src/a.ts',
  line: 3,
  severity: 'medium',
  title: 'Off by one',
  detail: 'The loop skips the last item.',
  ...over
});

describe('ReportFindings input', () => {
  it('takes the three severities and nothing else, and needs a title and the failure', () => {
    for (const severity of ['high', 'medium', 'low']) expect(ReportFindingsInput.safeParse({ findings: [finding({ severity: severity as 'high' })] }).success).toBe(true);
    expect(ReportFindingsInput.safeParse({ findings: [{ ...finding(), severity: 'critical' }] }).success).toBe(false);
    expect(ReportFindingsInput.safeParse({ findings: [finding({ title: '' })] }).success).toBe(false);
    expect(ReportFindingsInput.safeParse({ findings: [finding({ detail: '' })] }).success).toBe(false);
    expect(ReportFindingsInput.safeParse({ findings: [finding({ line: 0 })] }).success).toBe(false);
    expect(ReportFindingsInput.safeParse({ findings: [finding({ line: 2.5 })] }).success).toBe(false);
    expect(ReportFindingsInput.safeParse({ findings: [] }).success).toBe(true);
    expect(ReportFindingsInput.safeParse({ findings: Array.from({ length: 101 }, () => finding()) }).success).toBe(false);
  });
});

describe('findings as Graft keeps them', () => {
  it('names files from the project folder, puts line ranges in order and sorts worst first', () => {
    const { findings, outside } = normalizeFindings(
      {
        findings: [
          finding({ path: 'src/b.ts', line: 9, severity: 'low', title: ' Naming ', suggestion: '   ' }),
          finding({ path: path.join(dir, 'src', 'b.ts'), line: 20, endLine: 12, severity: 'high', suggestion: 'Check the bound.' }),
          finding({ path: './src/a.ts', line: 5, severity: 'high' }),
          finding({ path: 'src\\c.ts', line: 1, severity: 'medium' })
        ]
      },
      dir
    );
    expect(outside).toEqual([]);
    expect(findings.map((f) => [f.severity, f.path, f.line, f.endLine])).toEqual([
      ['high', 'src/a.ts', 5, 5],
      ['high', 'src/b.ts', 12, 20],
      ['medium', process.platform === 'win32' ? 'src/c.ts' : 'src\\c.ts', 1, 1],
      ['low', 'src/b.ts', 9, 9]
    ]);
    expect(findings[1]?.suggestion).toBe('Check the bound.');
    expect(findings[3]).toMatchObject({ title: 'Naming', suggestion: null });
    expect(severityCounts(findings)).toBe('2 high, 1 medium, 1 low');
  });

  it('refuses paths outside the project, and the project folder itself', () => {
    const { findings, outside } = normalizeFindings(
      { findings: [finding({ path: '../elsewhere/x.ts' }), finding({ path: '~/notes.txt' }), finding({ path: '.' }), finding({ path: path.dirname(dir) }), finding()] },
      dir
    );
    expect(outside).toEqual(['../elsewhere/x.ts', '~/notes.txt', '.', path.dirname(dir)]);
    expect(findings.map((f) => f.path)).toEqual(['src/a.ts']);
  });
});

describe('the ReportFindings tool', () => {
  it('shows the findings with the turn and tells the model what the user sees', async () => {
    const ctx = makeToolContext(dir);
    const result = await reportFindingsTool.execute({ findings: [finding(), finding({ severity: 'high', line: 1 })], summary: ' Looked at the parser. ' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.display).toEqual({
      kind: 'findings',
      summary: 'Looked at the parser.',
      findings: [
        { path: 'src/a.ts', line: 1, endLine: 1, severity: 'high', title: 'Off by one', detail: 'The loop skips the last item.', suggestion: null },
        { path: 'src/a.ts', line: 3, endLine: 3, severity: 'medium', title: 'Off by one', detail: 'The loop skips the last item.', suggestion: null }
      ]
    });
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Recorded 2 findings (1 high, 1 medium)') as string });
    const none = await reportFindingsTool.execute({ findings: [] }, ctx);
    expect(none.display).toEqual({ kind: 'findings', findings: [], summary: null });
    expect(await reportFindingsTool.describe({ findings: [finding()] }, ctx)).toEqual({ summary: 'Reported 1 finding' });
  });

  it('refuses the whole report when a path is outside the project, so the model sends it again', async () => {
    const result = await reportFindingsTool.execute({ findings: [finding(), finding({ path: '../x.ts' })] }, makeToolContext(dir));
    expect(result.isError).toBe(true);
    expect(result.display).toEqual({ kind: 'error', message: expect.stringContaining('../x.ts') as string });
    expect(reportFindingsTool.permissionClass).toBe('none');
  });

  it('belongs to the main agent: sub-agents and agents of a group never report findings to the user', () => {
    const names = createBuiltinRegistry().names();
    expect(names).toContain('ReportFindings');
    expect(PARENT_ONLY_TOOLS).toContain('ReportFindings');
    for (const role of ['reviewer', 'implementer', 'security']) {
      const resolved = resolveRole(role, names, []);
      expect(resolved.ok && resolved.tools.includes('ReportFindings')).toBe(false);
    }
  });
});
