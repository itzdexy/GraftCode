import { useState } from 'react';
import { FolderOpen, Pencil, Plus, Trash } from 'lucide-react';
import type { CustomScopeView, SkillFileView } from '@shared/schemas/customize';
import { Badge } from '../../components/Badge';
import { Button, IconButton } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { TextField } from '../../components/Field';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { errorText, invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { reportError } from '../../stores/toasts';
import { MONO_AREA, Row, Section, SELECT } from './shared';

/** A skill of the user's or the project's: the kind that can be edited. One that ships with Graft can only be read. */
type OwnSkill = SkillFileView & { scope: CustomScopeView };

const SCOPE_LABEL: Record<SkillFileView['scope'], string> = { builtin: 'Built in', user: 'All projects', project: 'This project' };

function SkillEditor({ skill, projectPath, onDone }: { skill: OwnSkill | null; projectPath: string | null; onDone: (saved: boolean) => void }) {
  const [scope, setScope] = useState<CustomScopeView>(skill?.scope ?? (projectPath ? 'project' : 'user'));
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    try {
      await invoke('customize:saveSkill', { scope, projectPath, name: name.trim().toLowerCase(), description, body, previousPath: skill?.path ?? null });
      onDone(true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <DialogContent
      title={skill ? `Edit ${skill.name}` : 'New skill'}
      description="Skills are instructions the agent loads when a task matches the description, so keep the description specific."
      className="w-[min(620px,calc(100vw-48px))]"
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || !description.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12">
        <div className="grid grid-cols-[1fr_160px] gap-8">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="db-migrations" spellCheck={false} />
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
        <TextField label="When to use it" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Writing or reviewing database migrations for this service" />
        <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
          Instructions (SKILL.md)
          <textarea className={MONO_AREA} rows={12} value={body} onChange={(e) => setBody(e.target.value)} placeholder={'# Migrations\n\n1. Generate with `npm run migrate:new`.\n2. …'} />
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

export function SkillsSection({ projectPath }: { projectPath: string | null }) {
  const { load, reload } = useLoad(() => invoke('customize:skills', { projectPath }), projectPath ?? '');
  const [editing, setEditing] = useState<OwnSkill | 'new' | null>(null);
  const showFolder = (s: SkillFileView): void => {
    // The skill's folder: the path of its SKILL.md without the file's name.
    invoke('app:revealPath', { path: s.path.replace(/[\\/][^\\/]*$/, '') }).catch((e: unknown) => reportError("Couldn't show the folder", e));
  };
  const remove = (s: SkillFileView): void => {
    invoke('customize:deleteSkill', { projectPath, path: s.path })
      .then(reload)
      .catch((e: unknown) => reportError("Couldn't delete the skill", e));
  };
  return (
    <Section
      title="Skills"
      description="Task-specific playbooks in ~/.graft/skills/<name>/SKILL.md or the project's .graft/skills. The agent reads one when its description fits the task. A skill of yours replaces a built-in one with the same name."
      actions={
        <Button size="sm" variant="secondary" leading={<Plus className="size-14" />} onClick={() => setEditing('new')}>
          New skill
        </Button>
      }
    >
      {load.status === 'loading' ? <LoadingState /> : null}
      {load.status === 'error' ? <ErrorState message={load.message} onRetry={reload} /> : null}
      {load.status === 'ready' && load.data.length === 0 ? <EmptyState title="No skills yet" description="Capture how your team does recurring tasks." /> : null}
      {load.status === 'ready' && load.data.length > 0 ? (
        <ul className="flex flex-col gap-[var(--g-session-row-gap)]">
          {load.data.map((s) => {
            const own: OwnSkill | null = s.scope === 'builtin' ? null : { ...s, scope: s.scope };
            return (
              <Row key={s.path}>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-8">
                    <span className="text-base font-medium text-fg-strong">{s.name}</span>
                    <Badge>{SCOPE_LABEL[s.scope]}</Badge>
                  </p>
                  <p className="truncate text-sm text-fg-muted">{s.description}</p>
                </div>
                {own ? (
                  <>
                    <IconButton label={`Edit ${s.name}`} onClick={() => setEditing(own)}>
                      <Pencil className="size-14" />
                    </IconButton>
                    <IconButton label={`Delete ${s.name}`} onClick={() => remove(s)}>
                      <Trash className="size-14" />
                    </IconButton>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" leading={<FolderOpen className="size-14" />} onClick={() => showFolder(s)}>
                    Show folder
                  </Button>
                )}
              </Row>
            );
          })}
        </ul>
      ) : null}
      <Dialog open={editing !== null} onOpenChange={(open) => (open ? undefined : setEditing(null))}>
        {editing ? (
          <SkillEditor
            key={editing === 'new' ? 'new' : editing.path}
            skill={editing === 'new' ? null : editing}
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
