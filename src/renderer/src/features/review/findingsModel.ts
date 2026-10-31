/**
 * The findings of a review as the card shows them (pure; unit-tested): by
 * file, counted by severity, and each one as the comment Fix leaves for the
 * agent's next message.
 */

import { FINDING_SEVERITIES, type Finding, type FindingSeverity } from '@shared/schemas/findings';
import type { ReviewComment } from './reviewModel';

/** One file's findings, each with the key its Fix or Dismiss is kept under. */
export interface FindingGroup {
  path: string;
  items: Array<{ finding: Finding; key: string }>;
}

/** What Fix and Dismiss are kept under: findings are told apart by their review (the call) and their place in it. */
export function findingKey(sessionId: string, callId: string, index: number): string {
  return `${sessionId}:${callId}:${String(index)}`;
}

/**
 * Findings by file. They arrive worst first, so each file comes where its worst
 * finding is, and a file's findings stay worst first, then by line.
 */
export function findingGroups(sessionId: string, callId: string, findings: readonly Finding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  findings.forEach((finding, index) => {
    const group = groups.get(finding.path) ?? { path: finding.path, items: [] };
    group.items.push({ finding, key: findingKey(sessionId, callId, index) });
    groups.set(finding.path, group);
  });
  return [...groups.values()];
}

/** How many findings of each severity there are, worst first; severities with none are left out. */
export function severityTally(findings: readonly Finding[]): Array<{ severity: FindingSeverity; count: number }> {
  return FINDING_SEVERITIES.map((severity) => ({ severity, count: findings.filter((f) => f.severity === severity).length })).filter((t) => t.count > 0);
}

/** `src/a.ts:12`, or `src/a.ts:12-14` for several lines. */
export function findingPlace(finding: Pick<Finding, 'path' | 'line' | 'endLine'>): string {
  return `${finding.path}:${String(finding.line)}${finding.endLine > finding.line ? `-${String(finding.endLine)}` : ''}`;
}

/** A finding as a comment on its lines, for the next message: what is wrong, how it fails, and the fix the review suggested. */
export function findingComment(finding: Finding): Omit<ReviewComment, 'id' | 'at'> {
  const title = finding.title.replace(/[.!?]+$/, '');
  const fix = finding.suggestion ? ` Suggested fix: ${finding.suggestion}` : '';
  return {
    path: finding.path,
    line: finding.line,
    endLine: finding.endLine,
    side: 'new',
    quote: '',
    text: `Fix this ${finding.severity}-severity finding: ${title}. ${finding.detail}${fix}`
  };
}
