import type { EffortLevel } from '@shared/schemas/common';

/** What the two deepest levels cost, said once above the message box. No multiplier is promised: it depends on the provider and the task. */
export const EFFORT_NOTICES: Partial<Record<EffortLevel, string>> = {
  max: 'Max effort thinks longer and can use several times the tokens of Medium.',
  taproot: 'Taproot works at the model’s highest effort, in longer loops, and checks its work before it finishes. A turn can use many times the tokens of Medium.'
};

export const EFFORT_NOTICE_KEY = 'graft.effortNotices.v1';

/** The levels whose notice was put away; kept on this computer. Anything unreadable counts as none. */
export function readPutAway(storage: Pick<Storage, 'getItem'> | null): EffortLevel[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(EFFORT_NOTICE_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((level): level is EffortLevel => typeof level === 'string' && level in EFFORT_NOTICES) : [];
  } catch {
    return [];
  }
}
