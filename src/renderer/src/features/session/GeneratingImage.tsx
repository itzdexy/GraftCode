import { useEffect, useId, useState } from 'react';
import { reducedMotion } from '../../lib/motion';
import { startSnake, stepSnake } from './snakeModel';
import { durationText } from './transcriptModel';

const COLS = 22;
const ROWS = 11;
const CELL = 12;
const STEP_MS = 120;

/**
 * A picture being made: a grid of dots on which a line of brighter dots
 * walks from one leaf-green dot to the next. The line above it (the block's
 * own) says what is being made; the corner says what the engine last
 * reported, or how long it has been. With reduced motion the grid holds still.
 */
export function GeneratingImage({ label, note }: { label: string; note: string | null }) {
  const pattern = useId();
  const [started] = useState(() => Date.now());
  // The walk and the clock move together: one update per step.
  const [frame, setFrame] = useState(() => ({ snake: startSnake(COLS, ROWS), now: started }));
  const [moving] = useState(() => !reducedMotion());
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => {
      if (!document.hidden) setFrame((f) => ({ snake: stepSnake(f.snake, COLS, ROWS), now: Date.now() }));
    }, STEP_MS);
    return () => clearInterval(timer);
  }, [moving]);
  const { snake } = frame;
  const at = (n: number): number => n * CELL + CELL / 2;
  const corner = note ?? (moving ? durationText(frame.now - started) : null);
  return (
    <div role="status" aria-label={label} className="flex px-4 py-4">
      <div className="graft-dotgrid relative overflow-hidden rounded-md border border-border-subtle bg-sunken">
        <svg width={COLS * CELL} height={ROWS * CELL} viewBox={`0 0 ${String(COLS * CELL)} ${String(ROWS * CELL)}`} aria-hidden="true" className="relative block max-w-full">
          <defs>
            <pattern id={pattern} width={CELL} height={CELL} patternUnits="userSpaceOnUse">
              <circle cx={CELL / 2} cy={CELL / 2} r={0.9} fill="var(--g-text-faint)" opacity={0.55} />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${pattern})`} />
          <circle className="graft-dotgrid__food" cx={at(snake.food.x)} cy={at(snake.food.y)} r={3.2} fill="var(--g-accent)" />
          {snake.body.map((cell, i) => (
            <circle key={i} cx={at(cell.x)} cy={at(cell.y)} r={i === 0 ? 3.6 : 3} fill="var(--g-text-strong)" opacity={1 - i * 0.15} />
          ))}
        </svg>
        {corner ? (
          <span className="absolute right-6 bottom-6 max-w-[70%] truncate rounded-full bg-control px-8 py-px text-2xs text-fg-secondary tabular-nums" aria-hidden="true">
            {corner}
          </span>
        ) : null}
      </div>
    </div>
  );
}
