import type { PageCheck, PageFinding } from './schemas/panels';

/** A page check in words: for the agent's tool result, the panel and a request to fix what it found (pure; unit-tested). */

function counted(count: number, one: string): string {
  return `${String(count)} ${count === 1 ? one : `${one}s`}`;
}

/** How many problems and warnings a check lists: "2 problems, 1 warning", or "nothing found". */
export function checkCounts(check: Pick<PageCheck, 'findings'>): string {
  const errors = check.findings.filter((finding) => finding.severity === 'error').length;
  const warnings = check.findings.length - errors;
  const parts = [errors > 0 ? counted(errors, 'problem') : null, warnings > 0 ? counted(warnings, 'warning') : null].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(', ') : 'nothing found';
}

/** One finding on a line: what is wrong, then where. */
export function findingLine(finding: PageFinding): string {
  const where = finding.selector ? ` At ${finding.selector}${finding.label ? ` (${JSON.stringify(finding.label)})` : ''}` : '';
  return `- ${finding.message}${where}`;
}

/** What was looked at, and what could not be: said with every check, so an empty list has a size. */
export function lookedAt(check: PageCheck): string {
  const { looked } = check;
  return [
    `Looked at ${counted(looked.texts, 'text')}, ${counted(looked.images, 'picture')}, ${counted(looked.controls, 'control')} and ${counted(looked.headings, 'heading')}.`,
    check.unjudged > 0 ? `Contrast was not judged for ${counted(check.unjudged, 'text')} over a picture or a gradient.` : null,
    check.partial ? 'The page has more than was looked at.' : null
  ]
    .filter((part): part is string => part !== null)
    .join(' ');
}

/** The findings that were left out of the list, as a line; null when all are listed. */
export function notListed(check: Pick<PageCheck, 'more'>): string | null {
  return check.more > 0 ? `…and ${counted(check.more, 'more finding')} that ${check.more === 1 ? 'is' : 'are'} not listed.` : null;
}

/** The check as text, for the agent's tool result. */
export function formatPageCheck(check: PageCheck): string {
  const errors = check.findings.filter((finding) => finding.severity === 'error');
  const warnings = check.findings.filter((finding) => finding.severity === 'warning');
  const more = notListed(check);
  const out = [`Checked ${check.title.trim() || 'the page'} (${check.url}) at ${String(check.width)} px wide: ${checkCounts(check)}.`];
  if (errors.length > 0) out.push('', 'Problems:', ...errors.map(findingLine));
  if (warnings.length > 0) out.push('', 'Warnings:', ...warnings.map(findingLine));
  if (more) out.push('', more);
  out.push('', lookedAt(check));
  return out.join('\n');
}
