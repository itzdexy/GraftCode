import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import scion from './scion.json';
import './brand.css';

/**
 * "Scion", Graft's pixel mascot: a seedling with two leaves growing from a
 * small clay pot with a face. The sprite lives in scion.json (shared with the
 * icon generator); cells are filled from the --g-mascot-* theme tokens.
 *
 * It moves like pixel art does, by swapping frames: the leaf poses and eye
 * frames from scion.json are drawn over the sprite and brand.css shows them
 * in turn, so every pose stays on the pixel grid.
 */
export type ScionPart = 'leaves' | 'stem' | 'pot' | 'eyes';

/**
 * none: still. draw: the boot animation. idle: blinks, glances around and
 * wiggles its leaves now and then. thinking: flaps its leaves while it works.
 */
export type ScionMotion = 'none' | 'draw' | 'idle' | 'thinking';

interface Cell {
  x: number;
  y: number;
  fill: string;
  part: ScionPart;
}

const PART: Record<string, ScionPart> = { L: 'leaves', D: 'leaves', S: 'stem', R: 'pot', P: 'pot', E: 'eyes' };
const FILLS: Record<string, string> = scion.fills;
const EYE_ROW = 5;
/** How long a click's cheer lasts (two hops). */
const CHEER_MS = 1100;

export const MASCOT_COLUMNS = scion.sprite[0]?.length ?? 0;
export const MASCOT_ROWS = scion.sprite.length;

function cellsOf(rows: readonly string[], top = 0): Cell[] {
  return rows.flatMap((row, dy) =>
    [...row].flatMap((cell, x) => {
      const fill = FILLS[cell];
      const part = PART[cell];
      return fill && part ? [{ x, y: top + dy, fill: `var(--g-mascot-${fill})`, part }] : [];
    })
  );
}

export const SCION_CELLS: readonly Cell[] = cellsOf(scion.sprite);
const LEAF_FRAMES = Object.entries(scion.frames.leaves).map(([name, rows]) => ({ name, cells: cellsOf(rows).filter((c) => c.part === 'leaves') }));
const EYE_FRAMES = Object.entries(scion.frames.eyes).map(([name, row]) => ({ name, cells: cellsOf([row], EYE_ROW) }));

function rects(cells: readonly Cell[]) {
  return cells.map((c) => <rect key={`${String(c.x)}-${String(c.y)}`} x={c.x} y={c.y} width={1} height={1} fill={c.fill} />);
}

export function scionRects(part?: ScionPart) {
  return rects(SCION_CELLS.filter((c) => part === undefined || c.part === part));
}

/** Scion's parts as groups that brand.css animates; extra frames stay hidden until a motion shows them. */
function ScionBody() {
  return (
    <g className="graft-mark__body">
      <g className="graft-mark__pot">
        {scionRects('pot')}
        <g className="graft-mark__eyes">{scionRects('eyes')}</g>
        {EYE_FRAMES.map((f) => (
          <g key={f.name} className={`graft-frame graft-frame--${f.name}`}>
            {rects(f.cells)}
          </g>
        ))}
      </g>
      <g className="graft-mark__stem">{scionRects('stem')}</g>
      <g className="graft-mark__leaves">
        <g className="graft-frame--rest">{scionRects('leaves')}</g>
        {LEAF_FRAMES.map((f) => (
          <g key={f.name} className={`graft-frame graft-frame--${f.name}`}>
            {rects(f.cells)}
          </g>
        ))}
      </g>
    </g>
  );
}

/** A click makes Scion cheer for a moment. */
function useCheer(): [boolean, () => void] {
  const [cheering, setCheering] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );
  const cheer = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setCheering(false);
    // A fresh frame restarts the animation when it is clicked again mid-cheer.
    requestAnimationFrame(() => setCheering(true));
    timer.current = window.setTimeout(() => setCheering(false), CHEER_MS);
  };
  return [cheering, cheer];
}

export interface ScionSvgProps {
  viewBox: string;
  width: number;
  height: number;
  motion?: ScionMotion;
  /** Hops when hovered and cheers when clicked. */
  interactive?: boolean;
  /** Accessible name; omit when Scion is decorative next to visible text. */
  title?: string;
  className?: string;
}

export function ScionSvg({ viewBox, width, height, motion = 'none', interactive = false, title, className }: ScionSvgProps) {
  const [cheering, cheer] = useCheer();
  return (
    <svg
      width={width}
      height={height}
      viewBox={viewBox}
      shapeRendering="crispEdges"
      className={cn(
        'graft-mark shrink-0',
        motion !== 'none' && `graft-mark--${motion}`,
        interactive && 'graft-mark--interactive',
        cheering && 'graft-mark--cheer',
        className
      )}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      onClick={interactive ? cheer : undefined}
    >
      <ScionBody />
    </svg>
  );
}

/** Scion at full sprite size, `pixel` screen pixels per cell. */
export function Mascot({ pixel = 3, motion = 'idle', interactive = true, className }: { pixel?: number; motion?: ScionMotion; interactive?: boolean; className?: string }) {
  return (
    <ScionSvg
      viewBox={`0 0 ${String(MASCOT_COLUMNS)} ${String(MASCOT_ROWS)}`}
      width={MASCOT_COLUMNS * pixel}
      height={MASCOT_ROWS * pixel}
      motion={motion}
      interactive={interactive}
      className={className}
    />
  );
}
