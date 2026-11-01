import { create } from 'zustand';
import { ATTEMPTS_MAX } from '@shared/schemas/attempts';
import type { ModelRef, PermissionMode } from '@shared/schemas/common';
import type { BranchState } from '../home/ContextChips';

/**
 * How the next message of a message box is sent: once (count 1), or as 2 to 4
 * attempts with a model each; a model left null is the session's own. Per box,
 * and back to once after the message went, so a costly choice is never kept by accident.
 */
export interface AttemptsChoice {
  count: number;
  models: Array<ModelRef | null>;
}

interface AttemptsChoiceState {
  choices: Record<string, AttemptsChoice>;
  setCount: (key: string, count: number) => void;
  setModel: (key: string, index: number, model: ModelRef | null) => void;
  clear: (key: string) => void;
}

export const useAttemptsChoice = create<AttemptsChoiceState>((set) => ({
  choices: {},
  setCount: (key, count) =>
    set((state) => ({ choices: { ...state.choices, [key]: { count: Math.min(Math.max(1, count), ATTEMPTS_MAX), models: state.choices[key]?.models ?? [] } } })),
  setModel: (key, index, model) =>
    set((state) => {
      const current = state.choices[key] ?? { count: 1, models: [] };
      const models = [...current.models];
      models[index] = model;
      return { choices: { ...state.choices, [key]: { ...current, models } } };
    }),
  clear: (key) =>
    set((state) => {
      const { [key]: _sent, ...rest } = state.choices;
      return { choices: rest };
    })
}));

/** Why the next message can't go as attempts here, or null when it can: a Git project, outside Plan mode. */
export function attemptsUnavailable(folder: string | null, branches: BranchState, mode: PermissionMode): string | null {
  if (!folder) return 'Attempts work in a session with a project folder.';
  if (branches.status === 'ready' && !branches.list.isRepo) return 'Attempts need the folder to be a Git repository.';
  if (branches.status === 'error') return `Attempts need Git, which isn't working here: ${branches.message}`;
  if (mode === 'plan') return 'Attempts change files, so they are off in Plan mode.';
  return null;
}

/** The models a message goes with, one per attempt, the session's model where none was picked; null when it goes once. */
export function attemptModels(choice: AttemptsChoice | undefined, sessionModel: ModelRef | null): ModelRef[] | null {
  if (!choice || choice.count < 2 || !sessionModel) return null;
  return Array.from({ length: choice.count }, (_, i) => choice.models[i] ?? sessionModel);
}
