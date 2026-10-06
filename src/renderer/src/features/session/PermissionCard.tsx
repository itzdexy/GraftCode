import { useState, type KeyboardEvent } from 'react';
import { ShieldAlert, TriangleAlert } from 'lucide-react';
import type { PermissionDecision, PermissionRequest } from '@shared/schemas/permissions';
import { Badge, Kbd } from '../../components/Badge';
import { Button } from '../../components/Button';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { reportError } from '../../stores/toasts';
import { Markdown } from './Markdown';
import { PLAN_MAX, planEdit } from './planModel';
import { EditDiff } from './ToolDetail';

const DETAIL = 'selectable max-h-[220px] overflow-auto rounded-sm bg-code-block px-10 py-6 font-mono text-[calc(var(--g-code-font-size)-1px)] leading-[1.5] whitespace-pre-wrap break-all text-fg';

/** A plan waiting for approval: as it reads, or as text to change before approving it. */
function PlanDetail({ plan, editing, onChange }: { plan: string; editing: boolean; onChange: (plan: string) => void }) {
  if (!editing) {
    return (
      <div className="max-h-[320px] overflow-y-auto rounded-sm bg-code-block px-12 py-8">
        <Markdown text={plan} variant="code" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <textarea
        autoFocus
        aria-label="Plan"
        aria-describedby="plan-edit-help"
        value={plan}
        onChange={(e) => onChange(e.target.value)}
        rows={12}
        maxLength={PLAN_MAX}
        spellCheck={false}
        className="selectable w-full resize-y rounded-sm border border-input-border bg-input px-10 py-8 font-mono text-[calc(var(--g-code-font-size)-1px)] leading-[1.5] text-fg outline-none focus:border-border-strong"
      />
      <p id="plan-edit-help" className="text-sm text-fg-muted">
        Approve sends your version to the agent.
      </p>
    </div>
  );
}

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
      // A plan has its own view, with an edit state: see PlanDetail.
      return null;
    case 'generic':
      return <pre className={DETAIL}>{d.text}</pre>;
  }
}

/**
 * A pending permission request above the composer: exactly what will run or
 * change, why Graft is asking, and Allow once / for session / always / Deny
 * (with optional feedback). Dangerous actions can only be allowed once. A plan
 * can be edited before it is approved: the agent then follows that version.
 */
export function PermissionCard({ sessionId, request }: { sessionId: string; request: PermissionRequest }) {
  const [busy, setBusy] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const offered = request.detail.kind === 'plan' ? request.detail.plan : null;
  const isPlan = offered !== null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(offered ?? '');
  const edit = planEdit(offered ?? '', draft);
  const canRemember = request.suggestedRule !== null && request.dangerous === null && !isPlan;

  const respond = async (decision: PermissionDecision, text?: string): Promise<void> => {
    setBusy(true);
    try {
      await invoke('sessions:respondPermission', {
        sessionId,
        requestId: request.id,
        decision,
        ...(text ? { feedback: text } : {}),
        // An approval carries the user's version of the plan when they changed it.
        ...(isPlan && decision !== 'deny' && edit.plan !== undefined ? { plan: edit.plan } : {})
      });
    } catch (error) {
      reportError("Couldn't send your decision", error);
      setBusy(false);
    }
  };

  const choices: Array<{ key: string; label: string; decision: PermissionDecision; variant: 'primary' | 'secondary' | 'ghost'; disabled?: boolean }> = isPlan
    ? [{ key: '1', label: 'Approve plan', decision: 'allow-once', variant: 'primary', disabled: !edit.canApprove }]
    : [
        { key: '1', label: 'Allow once', decision: 'allow-once', variant: 'primary' },
        ...(canRemember
          ? [
              { key: '2', label: 'Allow for session', decision: 'allow-session' as const, variant: 'secondary' as const },
              { key: '3', label: 'Always allow', decision: 'allow-always' as const, variant: 'secondary' as const }
            ]
          : [])
      ];
  /** A plan has one more key than its choices: 2 edits it, so feedback moves to 3. */
  const feedbackKey = String(choices.length + (isPlan ? 2 : 1));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Keys typed into the feedback line or the plan are text, not answers.
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || busy) return;
    const choice = choices.find((c) => c.key === event.key);
    if (choice) {
      event.preventDefault();
      if (!choice.disabled) void respond(choice.decision);
    } else if (isPlan && event.key === '2') {
      event.preventDefault();
      setEditing(!editing);
    } else if (event.key === feedbackKey) {
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
      <div className="mt-10">{isPlan ? <PlanDetail plan={draft} editing={editing} onChange={setDraft} /> : <Detail request={request} />}</div>
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
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setFeedbackOpen(true)} trailing={<Kbd className="ml-2">{feedbackKey}</Kbd>}>
            {isPlan ? 'Keep planning…' : 'Deny with feedback…'}
          </Button>
          {isPlan ? (
            <Button size="sm" variant="ghost" disabled={busy} aria-pressed={editing} onClick={() => setEditing(!editing)} trailing={<Kbd className="ml-2">2</Kbd>}>
              {editing ? 'Preview' : 'Edit plan'}
            </Button>
          ) : null}
          {choices
            .slice()
            .reverse()
            .map((choice) => (
              <Button
                key={choice.decision}
                size="sm"
                variant={choice.variant}
                disabled={busy || choice.disabled === true}
                onClick={() => void respond(choice.decision)}
                trailing={<Kbd className="ml-2">{choice.key}</Kbd>}
              >
                {choice.label}
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}
