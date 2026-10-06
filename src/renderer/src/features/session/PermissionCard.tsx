import { useState, type KeyboardEvent } from 'react';
import { ShieldAlert, TriangleAlert } from 'lucide-react';
import type { PermissionDecision, PermissionRequest } from '@shared/schemas/permissions';
import { Badge, Kbd } from '../../components/Badge';
import { Button } from '../../components/Button';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { reportError } from '../../stores/toasts';
import { Markdown } from './Markdown';
import { EditDiff } from './ToolDetail';

const DETAIL = 'selectable max-h-[220px] overflow-auto rounded-sm bg-code-block px-10 py-6 font-mono text-[calc(var(--g-code-font-size)-1px)] leading-[1.5] whitespace-pre-wrap break-all text-fg';

function Detail({ request }: { request: PermissionRequest }) {
  const d = request.detail;
  switch (d.kind) {
    case 'command':
      return (
        <div className="flex flex-col gap-4">
          <pre className={DETAIL}>{d.command}</pre>
          <p className="text-sm text-fg-muted">
            in {d.cwd}
            {d.background ? ' · runs in the background' : ''}
          </p>
        </div>
      );
    case 'edit':
      return (
        <div className="flex flex-col gap-4">
          <p className="font-mono text-sm text-fg-secondary">
            {d.created ? 'Create ' : 'Edit '}
            {d.path}
          </p>
          <EditDiff patch={d.patch} />
        </div>
      );
    case 'path':
      return <pre className={DETAIL}>{`${d.access === 'write' ? 'Write' : 'Read'} ${d.path}`}</pre>;
    case 'url':
      return <pre className={DETAIL}>{d.url}</pre>;
    case 'mcp':
      return (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-muted">
            {d.server} · {d.tool}
          </p>
          <pre className={DETAIL}>{d.input}</pre>
        </div>
      );
    case 'plan':
      return (
        <div className="max-h-[320px] overflow-y-auto rounded-sm bg-code-block px-12 py-8">
          <Markdown text={d.plan} variant="code" />
        </div>
      );
    case 'generic':
      return <pre className={DETAIL}>{d.text}</pre>;
  }
}

/**
 * A pending permission request above the composer: exactly what will run or
 * change, why Graft is asking, and Allow once / for session / always / Deny
 * (with optional feedback). Dangerous actions can only be allowed once.
 */
export function PermissionCard({ sessionId, request }: { sessionId: string; request: PermissionRequest }) {
  const [busy, setBusy] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const isPlan = request.detail.kind === 'plan';
  const canRemember = request.suggestedRule !== null && request.dangerous === null && !isPlan;

  const respond = async (decision: PermissionDecision, text?: string): Promise<void> => {
    setBusy(true);
    try {
      await invoke('sessions:respondPermission', { sessionId, requestId: request.id, decision, ...(text ? { feedback: text } : {}) });
    } catch (error) {
      reportError("Couldn't send your decision", error);
      setBusy(false);
    }
  };

  const choices: Array<{ key: string; label: string; decision: PermissionDecision; variant: 'primary' | 'secondary' | 'ghost' }> = isPlan
    ? [{ key: '1', label: 'Approve plan', decision: 'allow-once', variant: 'primary' }]
    : [
        { key: '1', label: 'Allow once', decision: 'allow-once', variant: 'primary' },
        ...(canRemember
          ? [
              { key: '2', label: 'Allow for session', decision: 'allow-session' as const, variant: 'secondary' as const },
              { key: '3', label: 'Always allow', decision: 'allow-always' as const, variant: 'secondary' as const }
            ]
          : [])
      ];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLInputElement || busy) return;
    const choice = choices.find((c) => c.key === event.key);
    if (choice) {
      event.preventDefault();
      void respond(choice.decision);
    } else if (event.key === String(choices.length + 1)) {
      event.preventDefault();
      setFeedbackOpen(true);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-label={request.title}
      aria-describedby={`perm-${request.id}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="motion-rise rounded-lg border border-border-card bg-sunken px-12 pt-10 pb-12 outline-none"
    >
      <div className="flex items-start gap-8">
        <ShieldAlert className={cn('mt-1 size-16 shrink-0', request.dangerous ? 'text-danger' : 'text-amber')} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-md font-medium text-fg-strong">
            {request.title}
            {request.agentLabel ? <span className="font-normal text-fg-muted"> · {request.agentLabel}</span> : null}
          </p>
          <p id={`perm-${request.id}`} className="mt-2 text-sm text-fg-muted">
            {request.reason}
          </p>
        </div>
        {request.outsideProject ? <Badge tone="warning">Outside the project</Badge> : null}
      </div>
      {request.dangerous ? (
        <p className="mt-8 flex items-start gap-6 rounded-sm bg-danger-bg px-8 py-6 text-sm text-danger">
          <TriangleAlert className="mt-1 size-12 shrink-0" aria-hidden="true" />
          {request.dangerous}
        </p>
      ) : null}
      <div className="mt-10">
        <Detail request={request} />
      </div>
      {canRemember && request.suggestedRule ? (
        <p className="mt-6 text-sm text-fg-muted">
          “Always allow” saves the rule <span className="font-mono text-fg-secondary">{request.suggestedRule}</span> for this project.
        </p>
      ) : null}
      {feedbackOpen ? (
        <form
          className="mt-10 flex gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            void respond('deny', feedback.trim() || undefined);
          }}
        >
          <input
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            aria-label={isPlan ? 'What should change in the plan' : 'What Graft should do instead'}
            placeholder={isPlan ? 'What should change in the plan?' : 'Tell Graft what to do instead'}
            className="h-28 min-w-0 flex-1 rounded-sm border border-input-border bg-input px-8 text-base text-fg outline-none focus:border-border-strong"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={busy}>
            {isPlan ? 'Keep planning' : 'Deny'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFeedbackOpen(false)} disabled={busy}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="mt-10 flex flex-wrap items-center justify-end gap-6">
          {isPlan ? null : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void respond('deny')}>
              Deny
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setFeedbackOpen(true)} trailing={<Kbd className="ml-2">{choices.length + 1}</Kbd>}>
            {isPlan ? 'Keep planning…' : 'Deny with feedback…'}
          </Button>
          {choices
            .slice()
            .reverse()
            .map((choice) => (
              <Button key={choice.decision} size="sm" variant={choice.variant} disabled={busy} onClick={() => void respond(choice.decision)} trailing={<Kbd className="ml-2">{choice.key}</Kbd>}>
                {choice.label}
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}
