import { useState } from 'react';
import { ChevronRight, Pencil, Plus, Trash } from 'lucide-react';
import type { CommandFileView, CustomScopeView } from '@shared/schemas/customize';
import { Badge } from '../../components/Badge';
import { Button, IconButton } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { TextField } from '../../components/Field';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { errorText, invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { reportError } from '../../stores/toasts';
import { MONO_AREA, Row, Section, SELECT } from './shared';

function CommandEditor({ command, projectPath, onDone }: { command: CommandFileView | null; projectPath: string | null; onDone: (saved: boolean) => void }) {
  const [scope, setScope] = useState<CustomScopeView>(command?.scope ?? (projectPath ? 'project' : 'user'));
  const [name, setName] = useState(command?.name ?? '');
  const [description, setDescription] = useState(command?.description ?? '');
  const [hint, setHint] = useState(command?.argumentHint ?? '');
  const [body, setBody] = useState(command?.body ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    try {
      await invoke('customize:saveCommand', {
        scope,
        projectPath,
        name: name.trim().toLowerCase(),
        description,
        argumentHint: hint.trim() || null,
        body,
        previousPath: command?.path ?? null
      });
      onDone(true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <DialogContent
      title={command ? `Edit /${command.name}` : 'New command'}
      description="Type /name in a session to send this prompt. $ARGUMENTS becomes whatever follows the command; $1…$9 are single words."
      className="w-[min(620px,calc(100vw-48px))]"
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || !body.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12">
        <div className="grid grid-cols-[1fr_160px] gap-8">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="release-notes" spellCheck={false} />
          <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
            Saved for
            <select className={SELECT} value={scope} onChange={(e) => setScope(e.target.value as CustomScopeView)}>
              <option value="user">All projects</option>
              <option value="project" disabled={!projectPath}>
                This project
              </option>
            </select>
          </label>
        </div>
        <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Draft release notes from recent commits" />
        <TextField label="Argument hint (optional)" value={hint} onChange={(e) => setHint(e.target.value)} placeholder="<version>" />
        <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
          Prompt
          <textarea className={MONO_AREA} rows={10} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write release notes for version $ARGUMENTS based on git log since the last tag." />
        </label>
        {error ? (
          <p role="alert" className="text-base text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </DialogContent>
  );
}

/** Custom slash commands (user and project) plus the built-in list. */
export function CommandsSection({ projectPath }: { projectPath: string | null }) {
  const { load, reload } = useLoad(() => invoke('customize:commands', { projectPath }), projectPath ?? '');
  const builtins = useLoad(() => invoke('commands:list', { projectPath: null }), 'builtin');
  const [editing, setEditing] = useState<CommandFileView | 'new' | null>(null);
  const [showBuiltins, setShowBuiltins] = useState(false);

  const remove = (c: CommandFileView): void => {
    invoke('customize:deleteCommand', { projectPath, path: c.path })
      .then(reload)
      .catch((e: unknown) => reportError("Couldn't delete the command", e));
  };

  return (
    <Section
      title="Commands"
      description="Reusable prompts you run with /name. Stored as Markdown in ~/.graft/commands or the project's .graft/commands."
      actions={
        <Button size="sm" variant="secondary" leading={<Plus className="size-14" />} onClick={() => setEditing('new')}>
          New command
        </Button>
      }
    >
      {load.status === 'loading' ? <LoadingState /> : null}
      {load.status === 'error' ? <ErrorState message={load.message} onRetry={reload} /> : null}
      {load.status === 'ready' && load.data.length === 0 ? <EmptyState title="No custom commands yet" description="Create one for prompts you send often." /> : null}
      {load.status === 'ready' && load.data.length > 0 ? (
        <ul className="flex flex-col gap-[var(--g-session-row-gap)]">
          {load.data.map((c) => (
            <Row key={c.path}>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-8">
                  <span className="font-mono text-base text-fg-strong">/{c.name}</span>
                  {c.argumentHint ? <span className="font-mono text-sm text-fg-muted">{c.argumentHint}</span> : null}
                  <Badge>{c.scope === 'user' ? 'All projects' : 'This project'}</Badge>
                </p>
                <p className="truncate text-sm text-fg-muted">{c.description}</p>
              </div>
              <IconButton label={`Edit /${c.name}`} onClick={() => setEditing(c)}>
                <Pencil className="size-14" />
              </IconButton>
              <IconButton label={`Delete /${c.name}`} onClick={() => remove(c)}>
                <Trash className="size-14" />
              </IconButton>
            </Row>
          ))}
        </ul>
      ) : null}
      <button type="button" aria-expanded={showBuiltins} onClick={() => setShowBuiltins(!showBuiltins)} className="flex items-center gap-6 self-start text-sm text-fg-muted hover:text-fg-secondary">
        Built-in commands
        <ChevronRight className={cn('size-12 transition-transform', showBuiltins && 'rotate-90')} aria-hidden="true" />
      </button>
      {showBuiltins && builtins.load.status === 'ready' ? (
        <ul className="grid grid-cols-[auto_1fr] gap-x-16 gap-y-4 text-sm">
          {builtins.load.data
            .filter((c) => c.source === 'builtin')
            .map((c) => (
              <li key={c.name} className="contents">
                <span className="font-mono text-fg-secondary">/{c.name}</span>
                <span className="text-fg-muted">{c.description}</span>
              </li>
            ))}
        </ul>
      ) : null}
      <Dialog open={editing !== null} onOpenChange={(open) => (open ? undefined : setEditing(null))}>
        {editing ? (
          <CommandEditor
            key={editing === 'new' ? 'new' : editing.path}
            command={editing === 'new' ? null : editing}
            projectPath={projectPath}
            onDone={(saved) => {
              setEditing(null);
              if (saved) reload();
            }}
          />
        ) : null}
      </Dialog>
    </Section>
  );
}
