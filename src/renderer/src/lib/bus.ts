/** Lightweight notifications for main-process "something changed" events (views re-fetch on them). */

export type ChangeTopic = 'mcp' | 'schedules';

const listeners = new Map<ChangeTopic, Set<() => void>>();

export function onChanged(topic: ChangeTopic, fn: () => void): () => void {
  let set = listeners.get(topic);
  if (!set) {
    set = new Set();
    listeners.set(topic, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

export function emitChanged(topic: ChangeTopic): void {
  for (const fn of listeners.get(topic) ?? []) fn();
}
