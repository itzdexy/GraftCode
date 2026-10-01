import { cn } from '../lib/cn';
import { MASCOT_COLUMNS, MASCOT_ROWS, scionRects } from './Mascot';
import './brand.css';

/**
 * Graft's mark: Scion the mascot, centered in a square box with crisp
 * pixels. Leaves, stem, pot and eyes are separate groups so they can move on
 * their own (see brand.css).
 */
const VIEW_BOX = `${String((MASCOT_COLUMNS - 12) / 2)} ${String((MASCOT_ROWS - 12) / 2)} 12 12`;

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
      viewBox={VIEW_BOX}
      shapeRendering="crispEdges"
      className={cn('graft-mark shrink-0', motion !== 'none' && `graft-mark--${motion}`, className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <g className="graft-mark__pot">
        {scionRects('pot')}
        <g className="graft-mark__eyes">{scionRects('eyes')}</g>
      </g>
      <g className="graft-mark__stem">{scionRects('stem')}</g>
      <g className="graft-mark__leaves">{scionRects('leaves')}</g>
    </svg>
  );
}
