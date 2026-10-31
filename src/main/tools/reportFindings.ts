import { z } from 'zod';
import { FINDING_SEVERITIES, SEVERITY_RANK, type Finding, type FindingSeverity } from '@shared/schemas/findings';
import { displayPath, isInside, resolvePath } from './paths';
import { errorResult, textResult, type ToolDefinition } from './types';

export const ReportFindingsInput = z.object({
  findings: z
    .array(
      z.object({
        path: z.string().min(1).max(1000).describe('The file, relative to the project folder.'),
        line: z.number().int().min(1).describe('The first line the finding is about, in the file as it is now.'),
        endLine: z.number().int().min(1).optional().describe('The last line, when it spans several.'),
        severity: z
          .enum(FINDING_SEVERITIES)
          .describe('high: it breaks something, loses data or opens a security hole. medium: a real bug in a less common case. low: minor, still worth fixing.'),
        title: z.string().min(1).max(200).describe('What is wrong, in a few words.'),
        detail: z.string().min(1).max(4000).describe('The concrete failure: what input or state leads to what wrong result.'),
        suggestion: z.string().max(4000).optional().describe('How to fix it.')
      })
    )
    .max(100)
    .describe('Every problem the review found; empty when it found none.'),
  summary: z.string().max(2000).optional().describe('One or two sentences on what was reviewed.')
});
export type ReportFindingsInput = z.infer<typeof ReportFindingsInput>;

/**
 * Findings as Graft keeps them: each path from the project folder with "/",
 * each range in order, worst first. A path outside the project names nothing
 * that could be fixed here, so it comes back in `outside` instead.
 */
export function normalizeFindings(input: ReportFindingsInput, root: string, platform: NodeJS.Platform = process.platform): { findings: Finding[]; outside: string[] } {
  const findings: Finding[] = [];
  const outside: string[] = [];
  for (const found of input.findings) {
    const abs = resolvePath(found.path, root);
    const rel = isInside(root, abs, platform) ? displayPath(abs, root, platform) : '.';
    if (rel === '.') {
      outside.push(found.path);
      continue;
    }
    const end = found.endLine ?? found.line;
    const suggestion = found.suggestion?.trim() ?? '';
    findings.push({
      path: rel,
      line: Math.min(found.line, end),
      endLine: Math.max(found.line, end),
      severity: found.severity,
      title: found.title.trim(),
      detail: found.detail.trim(),
      suggestion: suggestion.length > 0 ? suggestion : null
    });
  }
  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.path.localeCompare(b.path) || a.line - b.line);
  return { findings, outside };
}

/** "1 high, 2 medium": the severities that occur, worst first. */
export function severityCounts(findings: readonly Finding[]): string {
  return FINDING_SEVERITIES.flatMap((severity: FindingSeverity) => {
    const count = findings.filter((f) => f.severity === severity).length;
    return count > 0 ? [`${String(count)} ${severity}`] : [];
  }).join(', ');
}

export const reportFindingsTool: ToolDefinition<ReportFindingsInput> = {
  name: 'ReportFindings',
  description: [
    'Report what a code review found, so the user sees the findings as a list they can fix one by one.',
    'Call it once, at the end of a review, with every finding; an empty list says the review found nothing. It changes nothing.'
  ].join(' '),
  input: ReportFindingsInput,
  permissionClass: 'none',
  concurrencySafe: () => false,
  timeoutMs: 10_000,
  describe: (input) => Promise.resolve({ summary: `Reported ${String(input.findings.length)} ${input.findings.length === 1 ? 'finding' : 'findings'}` }),
  execute(input, ctx) {
    const { findings, outside } = normalizeFindings(input, ctx.projectRoot, ctx.platform);
    if (outside.length > 0) {
      return Promise.resolve(
        errorResult(`These paths are not files of the project, so nothing in them can be fixed here: ${outside.join(', ')}. Name files inside the project, relative to its folder, and call ReportFindings again with every finding.`)
      );
    }
    const summary = input.summary?.trim() ?? '';
    const told =
      findings.length === 0
        ? 'Recorded: the review found nothing. End your turn by saying what you checked.'
        : `Recorded ${String(findings.length)} ${findings.length === 1 ? 'finding' : 'findings'} (${severityCounts(findings)}). The user sees them as a list and chooses what to fix. End your turn with a short summary; don't list the findings again.`;
    return Promise.resolve(textResult(told, { kind: 'findings', findings, summary: summary.length > 0 ? summary : null }));
  }
};
