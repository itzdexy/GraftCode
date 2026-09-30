import { useEffect, useState } from 'react';
import { useApp } from '../../stores/app';
import { BootSplash } from './BootSplash';

/** First launch: long enough for the mark to draw itself; later launches: a brief splash. */
export const FIRST_RUN_MIN_MS = 2200;
export const FIRST_RUN_REDUCED_MOTION_MIN_MS = 900;
export const QUICK_MIN_MS = 350;

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Shows the splash until initialization finished and the minimum display time
 * elapsed, then calls `onDone`. Progress reflects real init steps from main.
 */
export function BootScreen({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const quick = useApp((s) => s.quickSplash);
  const known = useApp((s) => s.splashKnown);
  const progress = useApp((s) => s.progress);
  const [minElapsed, setMinElapsed] = useState(false);

  useEffect(() => {
    if (!known) return;
    const min = quick ? QUICK_MIN_MS : prefersReducedMotion() ? FIRST_RUN_REDUCED_MOTION_MIN_MS : FIRST_RUN_MIN_MS;
    const timer = setTimeout(() => setMinElapsed(true), min);
    return () => clearTimeout(timer);
  }, [known, quick]);

  useEffect(() => {
    if (ready && minElapsed) onDone();
  }, [ready, minElapsed, onDone]);

  if (!known) return <div className="app-drag h-full bg-bg" />;
  if (quick) return <BootSplash quick progress={null} label="" />;
  const fraction = progress && progress.total > 0 ? progress.done / progress.total : 0;
  return <BootSplash progress={fraction} label={progress?.label ?? 'Starting Graft'} />;
}
