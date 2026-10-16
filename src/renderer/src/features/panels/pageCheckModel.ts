/** What the Browser panel's page check says and asks for (pure; unit-tested). */

import { checkCounts, findingLine } from '@shared/pageCheck';
import type { PageCheck } from '@shared/schemas/panels';

/** A request to fix findings lists this many; the rest are counted. */
const MAX_LISTED = 30;

/** What a check found and how wide the page was: "2 problems, 1 warning at 390 px wide". */
export function checkHeadline(check: PageCheck): string {
  const counts = checkCounts(check);
  return `${counts.charAt(0).toUpperCase()}${counts.slice(1)} at ${String(check.width)} px wide`;
}

/** The number on the check button: the problems of the last check. Warnings alone show none. */
export function problemsFound(check: PageCheck | null): number {
  return check === null ? 0 : check.findings.filter((finding) => finding.severity === 'error').length;
}

/** The message that asks for the findings to be fixed. It is put in the message box; the user sends it. */
export function fixPageRequest(check: PageCheck, limit = MAX_LISTED): string {
  const more = check.findings.length - Math.min(check.findings.length, limit) + check.more;
  return [
    `Fix what the page check found on ${check.url} (laid out ${String(check.width)} px wide):`,
    ...check.findings.slice(0, limit).map(findingLine),
    ...(more > 0 ? [`…and ${String(more)} more.`] : [])
  ].join('\n');
}
