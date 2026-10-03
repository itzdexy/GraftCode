import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { ChecksScope, ChecksView } from '@shared/schemas/customize';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Checkbox, TextField } from '../../components/Field';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { errorText, invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { notify } from '../../stores/toasts';
import { MONO_AREA, Section, SELECT } from './shared';

const SCOPE_TEXT: Record<ChecksScope, string> = { project: 'Project (shared)', local: 'This computer only' };
const MAX_COMMANDS = 10;

function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function Editor({ view, projectPath, onSaved }: { view: ChecksView; projectPath: string; onSaved: () => void }) {
  const local = view.files.find((f) => f.scope === 'local');
  const [scope, setScope] = useState<ChecksScope>(local?.checks ? 'local' : 'project');
  const file = view.files.find((f) => f.scope === scope);
  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap items-end gap-12">
        <label className="flex w-[220px] flex-col gap-6 text-base font-medium text-fg-secondary">
          Saved in
          <select className={SELECT} value={scope} onChange={(e) => setScope(e.target.value as ChecksScope)}>
            <option value="project">{SCOPE_TEXT.project}</option>
            <option value="local">{SCOPE_TEXT.local}</option>
          </select>
        </label>
        <p className="min-w-0 flex-1 truncate pb-6 font-mono text-sm text-fg-faint" title={file?.path}>
          {file?.path}
        </p>
      </div>
      {file?.error ? (
        <p role="alert" className="selectable text-sm text-danger">
          {file.error}
        </p>
      ) : null}
      {/* Keyed by what the file holds: switching files, or saving, starts the form from the file again. */}
      <ChecksForm
        key={`${scope}:${JSON.stringify(file?.checks ?? null)}`}
        scope={scope}
        checks={file?.checks ?? null}
        broken={Boolean(file?.error)}
        suggestions={view.suggestions}
        projectPath={projectPath}
        onSaved={onSaved}
      />
    </div>
  );
}

interface ChecksFormProps {
  scope: ChecksScope;
  checks: ChecksView['files'][number]['checks'];
  broken: boolean;
  suggestions: string[];
  projectPath: string;
  onSaved: () => void;
}

function ChecksForm({ scope, checks, broken, suggestions, projectPath, onSaved }: ChecksFormProps) {
  const [text, setText] = useState(checks?.commands.join('\n') ?? '');
  const [fix, setFix] = useState(checks?.fix ?? true);
  const [timeout, setTimeoutText] = useState(String(checks?.timeoutSec ?? 300));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const commands = linesOf(text);
  const unused = suggestions.filter((s) => !commands.includes(s));
  const seconds = Number(timeout);

  const save = async (remove: boolean): Promise<void> => {
    if (!remove) {
      if (commands.length === 0) return setError('Add at least one command.');
      if (commands.length > MAX_COMMANDS) return setError(`Use at most ${MAX_COMMANDS} commands.`);
      if (!Number.isInteger(seconds) || seconds < 10 || seconds > 1800) return setError('The time limit is a whole number of seconds from 10 to 1800.');
    }
    setSaving(true);
    try {
      await invoke('checks:save', { scope, projectPath, checks: remove ? null : { commands, fix, timeoutSec: seconds } });
      notify(remove ? 'Checks removed' : 'Checks saved', remove ? undefined : 'They run after the agent’s next change.');
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
        Commands, one per line, run in order
        <textarea
          className={MONO_AREA}
          rows={Math.min(8, Math.max(3, commands.length + 1))}
          value={text}
          spellCheck={false}
          placeholder={suggestions[0] ?? 'npm test'}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
      </label>
      {unused.length > 0 ? (
        <div className="flex flex-wrap items-center gap-6">
          <span className="text-sm text-fg-muted">Found in this project:</span>
          {unused.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setText((t) => (t.trim() ? `${t.trimEnd()}\n${s}` : s))}
              className="inline-flex h-24 items-center gap-4 rounded-full border border-border px-8 font-mono text-sm text-fg-secondary transition-ui hover:border-border-strong hover:text-fg"
            >
              <Plus className="size-12" aria-hidden="true" />
              {s}
            </button>
          ))}
        </div>
      ) : null}
      <Checkbox label="When a check fails, send the output back to the agent to fix (up to 2 rounds)" checked={fix} onChange={(e) => setFix(e.target.checked)} />
      <TextField label="Time limit per command (seconds)" value={timeout} onChange={(e) => setTimeoutText(e.target.value)} inputMode="numeric" className="max-w-[220px]" />
      {error ? (
        <p role="alert" className="text-base text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex gap-8">
        <Button variant="primary" disabled={saving || broken} onClick={() => void save(false)}>
          Save checks
        </Button>
        {checks ? (
          <Button variant="ghost" disabled={saving} onClick={() => void save(true)}>
            Remove
          </Button>
        ) : null}
      </div>
    </>
  );
}

/** The project's checks: commands Graft runs after the agent changes files. */
export function ChecksSection({ projectPath }: { projectPath: string | null }) {
  const { load, reload } = useLoad(() => (projectPath ? invoke('checks:get', { projectPath }) : Promise.resolve(null)), projectPath ?? '');
  const view = load.status === 'ready' ? load.data : null;
  const active = view?.files.find((f) => f.scope === 'local' && f.checks) ?? view?.files.find((f) => f.scope === 'project' && f.checks) ?? null;

  return (
    <Section
      title="Checks"
      description="Commands Graft runs after the agent changes files, such as the type checker, the linter and the tests. When one fails, the agent reads the output and fixes the cause. Checks run only in trusted projects."
      actions={active ? <Badge>{active.scope === 'local' ? 'This computer’s checks apply' : 'Shared checks apply'}</Badge> : null}
    >
      {projectPath === null ? <EmptyState title="Pick a project" description="Checks belong to a project. Choose one above." /> : null}
      {load.status === 'loading' ? <LoadingState /> : null}
      {load.status === 'error' ? <ErrorState message={load.message} onRetry={reload} /> : null}
      {view && projectPath ? <Editor key={projectPath} view={view} projectPath={projectPath} onSaved={reload} /> : null}
    </Section>
  );
}
