import type { AppSettings } from '@shared/schemas/appSettings';
import type { ProjectSummary } from '@shared/schemas/app';
import { invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { useUi, type CodeContext } from '../../stores/ui';
import { startNew } from '../shell/shellActions';

/** Folder, base branch and worktree choice for the next code session, seeded from defaults. */
export function initialCodeContext(settings: AppSettings, projects: ProjectSummary[]): CodeContext {
  const last = settings.defaults.lastProjectPath;
  const project = projects.find((p) => p.path === last && p.exists) ?? projects.find((p) => p.exists) ?? null;
  return {
    projectPath: project?.path ?? null,
    branch: null,
    useWorktree: project?.settings.useWorktree ?? settings.defaults.useWorktree
  };
}

/** Selects a folder (registering it as a project) for the next code session. */
export async function chooseProject(path: string): Promise<void> {
  const project = await invoke('projects:add', { path });
  useApp.getState().upsertProject(project);
  const current = useUi.getState().codeContext;
  useUi.getState().setCodeContext({
    projectPath: project.path,
    branch: null,
    useWorktree: project.settings.useWorktree ?? current?.useWorktree ?? false
  });
}

/** Sidebar "+" on a project group: new code session in that folder. */
export async function newSessionIn(path: string): Promise<void> {
  await chooseProject(path);
  if (useApp.getState().settings?.ui.mode !== 'code') await useApp.getState().updateSettings({ ui: { mode: 'code' } });
  startNew();
}
