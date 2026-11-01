import { ScanSearch } from 'lucide-react';
import type { Finding, FindingSeverity } from '@shared/schemas/findings';
import type { ToolDisplay } from '@shared/schemas/toolDisplay';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { cn } from '../../lib/cn';
import { useResolvedPath } from '../../stores/fileRefs';
import { usePanels } from '../../stores/panels';
import { useReview } from '../../stores/review';
import { useFindingMarks, type FindingMark } from './findingMarks';
import { findingComment, findingGroups, findingKey, findingPlace, severityTally } from './findingsModel';

const TONE: Record<FindingSeverity, 'danger' | 'warning' | 'neutral'> = { high: 'danger', medium: 'warning', low: 'neutral' };
const LABEL: Record<FindingSeverity, string> = { high: 'High', medium: 'Medium', low: 'Low' };

/** Where a finding is: it opens the file at its line, as a file named in a reply does, once the file is known to exist. */
function Place({ sessionId, finding }: { sessionId: string; finding: Finding }) {
  const file = useResolvedPath(sessionId, finding.path);
  const place = findingPlace(finding);
  if (!file) return <span className="shrink-0 font-mono text-2xs text-fg-muted">{place}</span>;
  return (
    <button
      type="button"
      title={`Open ${finding.path} at line ${String(finding.line)}`}
      onClick={() => usePanels.getState().openFile(sessionId, file, { line: finding.line })}
      className="selectable shrink-0 rounded-xs font-mono text-2xs text-link underline-offset-2 hover:underline"
    >
      {place}
    </button>
  );
}

function FindingRow({ sessionId, finding, mark, onFix, onMark }: { sessionId: string; finding: Finding; mark: FindingMark | undefined; onFix: () => void; onMark: (mark: FindingMark | null) => void }) {
  const dismissed = mark === 'dismissed';
  return (
    <li className={cn('flex flex-col gap-4 px-12 py-8', dismissed && 'opacity-60')}>
      <div className="flex items-start gap-8">
        <Badge tone={TONE[finding.severity]} className="mt-2">
          {LABEL[finding.severity]}
        </Badge>
        <p className={cn('selectable min-w-0 flex-1 text-md font-medium break-words text-fg', dismissed && 'line-through')}>{finding.title}</p>
        <Place sessionId={sessionId} finding={finding} />
      </div>
      {dismissed ? null : (
        <>
          <p className="selectable text-md break-words whitespace-pre-wrap text-fg-secondary">{finding.detail}</p>
          {finding.suggestion ? (
            <p className="selectable text-md break-words whitespace-pre-wrap text-fg-muted">
              <span className="text-fg-secondary">Suggested fix: </span>
              {finding.suggestion}
            </p>
          ) : null}
        </>
      )}
      <div className="flex items-center gap-6">
        {dismissed ? (
          <Button size="xs" variant="ghost" aria-label={`Restore: ${finding.title}`} onClick={() => onMark(null)}>
            Restore
          </Button>
        ) : mark === 'fixed' ? (
          <span className="text-sm text-fg-muted">Added to your next message</span>
        ) : (
          <>
            <Button size="xs" variant="secondary" aria-label={`Fix: ${finding.title}`} onClick={onFix}>
              Fix
            </Button>
            <Button size="xs" variant="ghost" aria-label={`Dismiss: ${finding.title}`} onClick={() => onMark('dismissed')}>
              Dismiss
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * What a review found, by file, worst first. Fix adds a finding to the
 * comments that go with the next message (the bar above the message box
 * lists them); Dismiss sets one aside. Nothing is changed by either.
 */
export function FindingsCard({ sessionId, callId, display, error }: { sessionId: string; callId: string; display: Extract<ToolDisplay, { kind: 'findings' }> | null; error: string | null }) {
  const marks = useFindingMarks((s) => s.marks);
  if (error !== null) return <p className="text-md text-fg-muted">The review's findings couldn't be listed: {error}</p>;
  if (!display) return null;
  const { findings } = display;
  const open = findings.flatMap((finding, index) => {
    const key = findingKey(sessionId, callId, index);
    return marks[key] ? [] : [{ finding, key }];
  });
  const fix = (items: Array<{ finding: Finding; key: string }>): void => {
    for (const { finding } of items) useReview.getState().add(sessionId, findingComment(finding));
    useFindingMarks.getState().mark(
      items.map((item) => item.key),
      'fixed'
    );
  };
  return (
    <section aria-label="Review findings" className="overflow-hidden rounded-md border border-border-card">
      <header className="flex min-h-30 flex-wrap items-center gap-8 border-b border-border-subtle px-12 py-4 text-md">
        <ScanSearch className="size-13 shrink-0 text-icon" aria-hidden="true" />
        <span className="font-medium text-fg-strong">{findings.length === 0 ? 'No findings' : findings.length === 1 ? '1 finding' : `${String(findings.length)} findings`}</span>
        <span className="flex flex-1 flex-wrap items-center gap-4">
          {severityTally(findings).map(({ severity, count }) => (
            <Badge key={severity} tone={TONE[severity]}>
              {`${String(count)} ${severity}`}
            </Badge>
          ))}
        </span>
        {open.length > 0 ? (
          <Button size="xs" variant="secondary" aria-label="Fix all findings" onClick={() => fix(open)}>
            Fix all
          </Button>
        ) : null}
      </header>
      {display.summary ? <p className="selectable px-12 pt-8 text-md text-fg-secondary">{display.summary}</p> : null}
      {findings.length === 0 ? (
        <p className="px-12 py-8 text-md text-fg-muted">The review found nothing to fix.</p>
      ) : (
        findingGroups(sessionId, callId, findings).map((group) => (
          <div key={group.path} className="border-b border-border-subtle last:border-b-0">
            {/* Cut at the start, so a long path still ends in its file name. */}
            <h3 className="truncate px-12 pt-8 text-left font-mono text-sm font-normal text-fg-muted [direction:rtl]" title={group.path}>
              <bdi>{group.path}</bdi>
            </h3>
            <ul aria-label={`Findings in ${group.path}`}>
              {group.items.map(({ finding, key }) => (
                <FindingRow
                  key={key}
                  sessionId={sessionId}
                  finding={finding}
                  mark={marks[key]}
                  onFix={() => fix([{ finding, key }])}
                  onMark={(mark) => useFindingMarks.getState().mark([key], mark)}
                />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
