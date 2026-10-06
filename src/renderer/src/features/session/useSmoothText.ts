import { useEffect, useRef, useState } from 'react';
import { reducedMotion } from '../../lib/motion';
import { nextReveal } from './streaming';

/** New words fade in with CSS, so thirty updates a second look smooth and halve the work. */
const TICK_MS = 30;
/** How long the last words take to finish fading in (.graft-word). */
const SETTLE_MS = 360;

/**
 * A reply as it should be shown right now. Text reaches the app in uneven
 * bursts; this lets it out at an even pace (see nextReveal), so a reply reads
 * as writing rather than as jumps. `streaming` stays true until the text has
 * caught up and its last words have settled. A reply that was already complete
 * when it was first shown, and any reply under reduced motion, shows whole.
 */
export function useSmoothText(text: string, live: boolean): { text: string; streaming: boolean } {
  const still = reducedMotion();
  const [shown, setShown] = useState(live && !still ? 0 : text.length);
  const [settled, setSettled] = useState(!live);
  const latest = useRef(text);
  useEffect(() => {
    latest.current = text;
  }, [text]);

  const visible = still ? text.length : Math.min(shown, text.length);
  const behind = visible < text.length;

  useEffect(() => {
    if (!behind) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now: number) {
      const elapsed = now - last;
      if (elapsed >= TICK_MS) {
        last = now;
        setShown((current) => nextReveal(latest.current, Math.min(current, latest.current.length), elapsed));
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [behind]);

  const done = !live && !behind;
  useEffect(() => {
    if (!done || settled) return;
    const timer = setTimeout(() => setSettled(true), still ? 0 : SETTLE_MS);
    return () => clearTimeout(timer);
  }, [done, settled, still]);

  return { text: behind ? text.slice(0, visible) : text, streaming: !(done && settled) };
}
