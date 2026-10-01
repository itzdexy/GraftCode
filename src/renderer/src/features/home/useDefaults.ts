import { useMemo } from 'react';
import type { ProjectSummary } from '@shared/schemas/app';
import { EFFORT_LEVELS, PERMISSION_MODES, type EffortLevel, type PermissionMode } from '@shared/schemas/common';
import type { ModelInfo } from '@shared/schemas/models';
import { invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { reportError } from '../../stores/toasts';
import { effortFor, resolveModel } from '../models/modelChoice';

export interface Defaults {
  model: ModelInfo | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  /** Why sending is impossible right now, or null. */
  blockedReason: string | null;
  setModel: (model: ModelInfo) => void;
  setEffort: (effort: EffortLevel) => void;
  setPermissionMode: (mode: PermissionMode) => void;
}

function save(patch: Parameters<ReturnType<typeof useApp.getState>['updateSettings']>[0]): void {
  useApp
    .getState()
    .updateSettings(patch)
    .catch((e: unknown) => reportError("Couldn't save your default", e));
}

function saveProject(project: ProjectSummary, settings: ProjectSummary['settings']): void {
  invoke('projects:update', { id: project.id, settings })
    .then((p) => useApp.getState().upsertProject(p))
    .catch((e: unknown) => reportError("Couldn't save the project default", e));
}

const asEffort = (v: string | undefined): EffortLevel | null => ((EFFORT_LEVELS as readonly string[]).includes(v ?? '') ? (v as EffortLevel) : null);
const asMode = (v: string | undefined): PermissionMode | null => ((PERMISSION_MODES as readonly string[]).includes(v ?? '') ? (v as PermissionMode) : null);

/**
 * Model, effort and permission mode for new sessions. A project's own
 * defaults (Projects → Settings) win over the global ones; changing a value
 * here updates whichever of the two it came from.
 */
export function useDefaults(project: ProjectSummary | null = null): Defaults {
  const groups = useApp((s) => s.models);
  const loading = useApp((s) => s.modelsLoading);
  const modelsError = useApp((s) => s.modelsError);
  const defaults = useApp((s) => s.settings?.defaults);
  const providers = useApp((s) => s.providers);

  return useMemo(() => {
    const ps = project?.settings ?? {};
    const model = resolveModel(groups, ps.model ?? defaults?.model ?? null);
    const effort = effortFor(model, asEffort(ps.effort) ?? defaults?.effort ?? null);
    let blockedReason: string | null = null;
    if (!model) {
      if (loading) blockedReason = 'Loading models…';
      else if (modelsError) blockedReason = `Couldn't load models: ${modelsError}`;
      else if (providers.length === 0) blockedReason = 'Add a model provider first';
      else blockedReason = 'No models available from your providers';
    }
    return {
      model,
      effort,
      permissionMode: asMode(ps.permissionMode) ?? defaults?.permissionMode ?? 'ask',
      blockedReason,
      setModel: (next) => {
        const nextEffort = next.effort ? (effortFor(next, effort) ?? next.effort.default) : null;
        if (project && ps.model) saveProject(project, { ...ps, model: next.ref, ...(nextEffort ? { effort: nextEffort } : {}) });
        else save({ defaults: { model: next.ref, ...(nextEffort ? { effort: nextEffort } : {}) } });
      },
      setEffort: (next) => {
        if (project && ps.effort) saveProject(project, { ...ps, effort: next });
        else save({ defaults: { effort: next } });
      },
      setPermissionMode: (next) => {
        if (project && ps.permissionMode) saveProject(project, { ...ps, permissionMode: next });
        else save({ defaults: { permissionMode: next } });
      }
    };
  }, [groups, loading, modelsError, defaults, providers.length, project]);
}
