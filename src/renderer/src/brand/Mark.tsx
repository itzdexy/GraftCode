import { cn } from '../lib/cn';
import './brand.css';

/**
 * The Graft mark: an open "G" drawn as a single stroke whose upper terminal
 * sprouts a leaf — a scion grafted onto the letter. Geometry (32×32 grid):
 * arc centered at (15,17), r=10, from -45° counter-clockwise to 0°, then the
 * crossbar to x=17; the leaf is an almond from the terminal toward 45°.
 */
export const MARK_ARC = 'M22.07 9.93 A10 10 0 1 0 25 17 H17';
export const MARK_LEAF = 'M22.07 9.93 Q27.16 9.36 27.73 4.27 Q22.64 4.84 22.07 9.93 Z';
/** Arc (315° of r=10) plus crossbar, used for the stroke-draw animation. */
export const MARK_STROKE_LENGTH = 63;

export type MarkMotion = 'none' | 'draw' | 'thinking';

interface MarkProps {
  size?: number;
  motion?: MarkMotion;
  className?: string;
  /** Accessible name; omit when the mark is decorative next to visible text. */
  title?: string;
}

export function Mark({ size = 20, motion = 'none', className, title }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={cn('graft-mark shrink-0 text-accent', motion !== 'none' && `graft-mark--${motion}`, className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path
        className="graft-mark__arc"
        d={MARK_ARC}
        fill="none"
        stroke="currentColor"
        strokeWidth={3.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ strokeDasharray: MARK_STROKE_LENGTH }}
      />
      <path className="graft-mark__leaf" d={MARK_LEAF} fill="currentColor" />
    </svg>
  );
}
