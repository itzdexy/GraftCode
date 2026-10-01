import { useEffect, useState } from 'react';
import { Mark } from '../../brand/Mark';

export const THINKING_VERBS = [
  'Thinking',
  'Weighing options',
  'Grafting',
  'Tending',
  'Pruning',
  'Cultivating',
  'Rooting around',
  'Sorting it out',
  'Planning',
  'Considering'
] as const;

const ROTATE_MS = 2400;

function elapsedText(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Animated mark with a rotating verb while the agent works. */
export function ThinkingIndicator({ startedAt, detail }: { startedAt: number | null; detail?: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = startedAt === null ? 0 : Math.max(0, now - startedAt);
  const verb = THINKING_VERBS[Math.floor(elapsed / ROTATE_MS) % THINKING_VERBS.length] ?? THINKING_VERBS[0];
  return (
    <div className="flex items-center gap-8 py-4 text-md text-fg-muted">
      <span role="status" className="sr-only">
        Graft is working
      </span>
      <Mark size={20} motion="thinking" />
      <span key={verb} className="graft-verb text-fg-secondary" aria-hidden="true">
        {verb}…
      </span>
      {startedAt === null ? null : (
        <span className="text-sm text-fg-faint" aria-hidden="true">
          {elapsedText(elapsed)}
        </span>
      )}
      {detail ? <span className="min-w-0 truncate text-sm text-fg-muted">· {detail}</span> : null}
    </div>
  );
}
