import { useMemo, useState } from 'react';
import { EllipsisVertical, FolderOpen, FolderPlus, Plus, Settings2, ShieldCheck, ShieldOff, Trash } from 'lucide-react';
import type { ProjectSummary } from '@shared/schemas/app';
import type { EffortLevel, PermissionMode } from '@shared/schemas/common';
import { Badge } from '../../components/Badge';
import { Button, IconButton } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { Checkbox, TextField } from '../../components/Field';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/Menu';
import { EmptyState, ErrorState } from '../../components/States';
import { EFFORT_LABELS, PERMISSION_MODE_INFO, relativeTime } from '../../lib/format';
import { errorText, invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { useSessions } from '../../stores/sessions';
import { reportError } from '../../stores/toasts';
import { pickProjectFolder } from '../home/ContextChips';
import { newSessionIn } from '../home/codeContext';
import { allModelsOf } from '../models/modelChoice';
import { PageLayout } from '../shell/PageLayout';

const MODES: PermissionMode[] = ['ask', 'auto-edit', 'plan', 'auto'];

function SettingsDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const groups = useApp((s) => s.models);
  const models = useMemo(() => allModelsOf(groups), [groups]);
  const [name, setName] = useState(project.name);
  const [modelKey, setModelKey] = useState(project.settings.model ? `${project.settings.model.providerId}\u0000${project.settings.model.modelId}` : '');
  const [effort, setEffort] = useState(project.settings.effort ?? '');
  const [mode, setMode] = useState(project.settings.permissionMode ?? '');
  const [worktree, setWorktree] = useState(project.settings.useWorktree ?? false);
  const [error, setError] = useState<string | null>(null);
  const model = models.find((m) => `${m.ref.providerId}\u0000${m.ref.modelId}` === modelKey) ?? null;

  const save = async (): Promise<void> => {
    try {
      const updated = await invoke('projects:update', {
        id: project.id,
        name: name.trim() || project.name,
        settings: {
          ...(model ? { model: model.ref } : {}),
          ...(effort ? { effort } : {}),
          ...(mode ? { permissionMode: mode } : {}),
          useWorktree: worktree
        }
      });
      useApp.getState().upsertProject(updated);
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const select = 'h-32 w-full rounded-md border border-input-border bg-input px-8 text-base text-fg outline-none focus:border-border-strong';
  return (
    <DialogContent
      title={`${project.name} settings`}
      description="Defaults for new sessions in this folder. Leave a field empty to use your global default."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
          Model
          <select className={select} value={modelKey} onChange={(e) => setModelKey(e.target.value)}>
            <option value="">Use the global default</option>
            {models.map((m) => (
              <option key={`${m.ref.providerId}/${m.ref.modelId}`} value={`${m.ref.providerId}\u0000${m.ref.modelId}`}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        {model?.effort ? (
          <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
            Effort
            <select className={select} value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="">Use the global default</option>
              {model.effort.levels.map((l: EffortLevel) => (
                <option key={l} value={l}>
                  {EFFORT_LABELS[l]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
          Permission mode
          <select className={select} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">Use the global default</option>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {PERMISSION_MODE_INFO[m].label} — {PERMISSION_MODE_INFO[m].description}
              </option>
            ))}
          </select>
        </label>
        <Checkbox label="Start new sessions in their own worktree" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
        {error ? (
          <p role="alert" className="text-base text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </DialogContent>
  );
}

function ProjectRow({ project, sessions, onSettings }: { project: ProjectSummary; sessions: number; onSettings: () => void }) {
  const update = (patch: { trusted?: boolean }): void => {
    invoke('projects:update', { id: project.id, ...patch })
      .then((p) => useApp.getState().upsertProject(p))
      .catch((e: unknown) => reportError("Couldn't update the project", e));
  };
  const remove = (): void => {
    invoke('projects:remove', { id: project.id })
      .then(() => useApp.getState().loadProjects())
      .catch((e: unknown) => reportError("Couldn't remove the project", e));
  };
  return (
    <li className="flex min-h-[52px] items-center gap-12 rounded-md bg-raised px-12 py-8">
      <FolderOpen className="size-16 shrink-0 text-icon" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-8">
          <span className="truncate text-base font-medium text-fg-strong">{project.name}</span>
          {project.trusted ? <Badge tone="accent">Trusted</Badge> : null}
          {!project.exists ? <Badge tone="danger">Folder missing</Badge> : null}
        </div>
        <p className="selectable truncate text-sm text-fg-muted" title={project.path}>
          {project.path}
        </p>
      </div>
      <span className="hidden shrink-0 text-sm text-fg-muted min-[900px]:inline">
        {sessions} {sessions === 1 ? 'session' : 'sessions'} · used {relativeTime(project.lastUsedAt)}
      </span>
      <Button
        size="sm"
        variant="secondary"
        disabled={!project.exists}
        leading={<Plus className="size-14" />}
        onClick={() => newSessionIn(project.path).catch((e: unknown) => reportError("Couldn't open the folder", e))}
      >
        New session
      </Button>
      <Menu>
        <MenuTrigger asChild>
          <IconButton label={`Options for ${project.name}`}>
            <EllipsisVertical className="size-16" />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end" className="min-w-[220px]">
          <MenuItem icon={<Settings2 className="size-14" />} onSelect={onSettings}>
            Settings…
          </MenuItem>
          {project.trusted ? (
            <MenuItem icon={<ShieldOff className="size-14" />} onSelect={() => update({ trusted: false })} description="Stop using its allow rules, hooks and MCP servers">
              Stop trusting
            </MenuItem>
          ) : (
            <MenuItem icon={<ShieldCheck className="size-14" />} onSelect={() => update({ trusted: true })} description="Use its allow rules, hooks and MCP servers">
              Trust this project
            </MenuItem>
          )}
          <MenuItem
            icon={<FolderOpen className="size-14" />}
            disabled={!project.exists}
            onSelect={() => {
              invoke('app:openInEditor', { path: project.path }).catch((e: unknown) => reportError("Couldn't open the folder", e));
            }}
          >
            Open in editor
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<Trash className="size-14 text-danger" />} disabled={sessions > 0} onSelect={remove} description={sessions > 0 ? 'Delete its sessions first' : 'Files on disk are not touched'}>
            Remove from Graft
          </MenuItem>
        </MenuContent>
      </Menu>
    </li>
  );
}

/** Project folders with their defaults, trust and sessions. */
export function ProjectsView() {
  const projects = useApp((s) => s.projects);
  const projectsError = useApp((s) => s.projectsError);
  const summaries = useSessions((s) => s.summaries);
  const [editing, setEditing] = useState<ProjectSummary | null>(null);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of Object.values(summaries)) if (s.projectId) map.set(s.projectId, (map.get(s.projectId) ?? 0) + 1);
    return map;
  }, [summaries]);

  const add = (): void => {
    pickProjectFolder().catch((e: unknown) => reportError("Couldn't add that folder", e));
  };

  return (
    <PageLayout
      title="Projects"
      description="Folders Graft works in. Each keeps its own sessions, defaults and trust."
      actions={
        <Button variant="secondary" leading={<FolderPlus className="size-14" />} onClick={add}>
          Add folder
        </Button>
      }
    >
      {projectsError ? <ErrorState message={projectsError} onRetry={() => void useApp.getState().loadProjects()} /> : null}
      {!projectsError && projects.length === 0 ? (
        <EmptyState icon={<FolderOpen className="size-20" />} title="No projects yet" description="Add a folder, or start a code session in one." action={<Button onClick={add}>Add folder</Button>} />
      ) : null}
      <ul className="flex flex-col gap-[var(--g-session-row-gap)]">
        {projects.map((p) => (
          <ProjectRow key={p.id} project={p} sessions={counts.get(p.id) ?? 0} onSettings={() => setEditing(p)} />
        ))}
      </ul>
      <Dialog open={editing !== null} onOpenChange={(open) => (open ? undefined : setEditing(null))}>
        {editing ? <SettingsDialog key={editing.id} project={editing} onClose={() => setEditing(null)} /> : null}
      </Dialog>
    </PageLayout>
  );
}
