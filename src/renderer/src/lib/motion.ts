import { useEffect, useState, useSyncExternalStore } from 'react';
import type { MotionSetting } from '@shared/schemas/appSettings';

/** Matches --g-duration-exit: how long something that leaves stays in the page. */
export const EXIT_MS = 110;

/** Whether motion is reduced under a Motion setting, given what the operating system asks for. */
export function motionReduced(setting: MotionSetting, systemReduced: boolean): boolean {
  return setting === 'system' ? systemReduced : setting === 'reduced';
}

/**
 * The data-motion value for a Motion setting. "System" sets none, so the
 * stylesheet's prefers-reduced-motion query decides (also before settings load).
 */
export function motionAttribute(setting: MotionSetting): 'full' | 'reduced' | null {
  return setting === 'system' ? null : setting === 'on' ? 'full' : 'reduced';
}

/**
 * A tip for someone whose system has animations turned off while Graft
 * follows the system: Graft can animate anyway, and most people who switched
 * system animations off for speed never look for that in Settings. Null when
 * there is nothing to offer.
 */
export function motionTip(setting: MotionSetting, systemReduced: boolean, system: string, enable: () => void): { id: string; text: string; action: string; run: () => void } | null {
  if (setting !== 'system' || !systemReduced) return null;
  return { id: 'motion-system-off', text: `${system} has animations turned off, so Graft keeps still. Animate Graft anyway?`, action: 'Turn on', run: enable };
}

const MOTION_KEY = 'graft.motion';

/** Remembers the page's motion mark, so the next launch's splash already follows it (settings load after it shows). */
export function rememberMotion(mark: 'full' | 'reduced' | null): void {
  try {
    if (mark === null) localStorage.removeItem(MOTION_KEY);
    else localStorage.setItem(MOTION_KEY, mark);
  } catch {
    // rocky: without storage the splash follows the system until settings load; nothing else depends on it.
  }
}

/** Marks the page with the remembered Motion setting before anything renders. */
export function restoreMotion(): void {
  try {
    const mark = localStorage.getItem(MOTION_KEY);
    if (mark === 'full' || mark === 'reduced') document.documentElement.dataset.motion = mark;
  } catch {
    // rocky: same as above; the system's setting applies until settings load.
  }
}

const SYSTEM_QUERY = '(prefers-reduced-motion: reduce)';

/** True when the operating system asks for less motion (on Windows: "Animation effects" is off). */
export function systemReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(SYSTEM_QUERY).matches;
}

function subscribeSystem(onChange: () => void): () => void {
  const query = window.matchMedia(SYSTEM_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** The system's request for less motion, kept current while the setting changes outside the app. */
export function useSystemReducedMotion(): boolean {
  return useSyncExternalStore(subscribeSystem, systemReducedMotion);
}

/** True when motion is reduced right now: by the Motion setting, or by the system when the setting follows it. */
export function reducedMotion(): boolean {
  if (typeof document === 'undefined') return true;
  const marked = document.documentElement.dataset.motion;
  return marked === 'reduced' || (marked !== 'full' && systemReducedMotion());
}

/**
 * A list as it should be shown: its items, plus the ones just removed for as
 * long as their leaving takes to show (`leaving` is true for those).
 */
export function useLingering<T>(items: T[], keyOf: (item: T) => string | number, exitMs = EXIT_MS): Array<{ item: T; leaving: boolean }> {
  const [seen, setSeen] = useState(items);
  const [shown, setShown] = useState(() => items.map((item) => ({ item, leaving: false })));
  if (items !== seen) {
    setSeen(items);
    const current = new Map(items.map((item) => [keyOf(item), item]));
    const known = new Set(shown.map((entry) => keyOf(entry.item)));
    setShown([
      ...shown.map((entry) => {
        const now = current.get(keyOf(entry.item));
        return now === undefined ? { item: entry.item, leaving: true } : { item: now, leaving: false };
      }),
      ...items.filter((item) => !known.has(keyOf(item))).map((item) => ({ item, leaving: false }))
    ]);
  }
  const anyLeaving = shown.some((entry) => entry.leaving);
  useEffect(() => {
    if (!anyLeaving) return;
    const timer = setTimeout(() => setShown((entries) => entries.filter((entry) => !entry.leaving)), reducedMotion() ? 0 : exitMs);
    return () => clearTimeout(timer);
  }, [anyLeaving, exitMs]);
  return shown;
}

/**
 * Keeps something in the page for a moment after it closes, so its leaving
 * can be shown: true while open, and for `exitMs` afterwards (not at all with
 * reduced motion).
 */
export function usePresence(open: boolean, exitMs = EXIT_MS): boolean {
  const [seen, setSeen] = useState(open);
  const [leaving, setLeaving] = useState(false);
  if (open !== seen) {
    setSeen(open);
    setLeaving(!open);
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(false), reducedMotion() ? 0 : exitMs);
    return () => clearTimeout(timer);
  }, [leaving, exitMs]);
  return open || leaving;
}
