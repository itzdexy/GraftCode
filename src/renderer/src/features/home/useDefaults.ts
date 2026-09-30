import { useMemo } from 'react';
import type { EffortLevel, PermissionMode } from '@shared/schemas/common';
import type { ModelInfo } from '@shared/schemas/models';
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

/** Model, effort and permission mode used for new sessions; the home composers edit these defaults. */
export function useDefaults(): Defaults {
  const groups = useApp((s) => s.models);
  const loading = useApp((s) => s.modelsLoading);
  const modelsError = useApp((s) => s.modelsError);
  const defaults = useApp((s) => s.settings?.defaults);
  const providers = useApp((s) => s.providers);

  return useMemo(() => {
    const model = resolveModel(groups, defaults?.model ?? null);
    const effort = effortFor(model, defaults?.effort ?? null);
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
      permissionMode: defaults?.permissionMode ?? 'ask',
      blockedReason,
      setModel: (next) => save({ defaults: { model: next.ref, ...(next.effort ? { effort: effortFor(next, defaults?.effort ?? null) ?? next.effort.default } : {}) } }),
      setEffort: (next) => save({ defaults: { effort: next } }),
      setPermissionMode: (next) => save({ defaults: { permissionMode: next } })
    };
  }, [groups, loading, modelsError, defaults, providers.length]);
}
