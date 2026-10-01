import scion from './scion.json';

/**
 * "Scion", Graft's pixel mascot: a seedling with two leaves growing from a
 * small clay pot with a face. The sprite lives in scion.json (shared with the
 * icon generator); cells are filled from the --g-mascot-* theme tokens.
 */
export type ScionPart = 'leaves' | 'stem' | 'pot' | 'eyes';

const PART: Record<string, ScionPart> = { L: 'leaves', D: 'leaves', S: 'stem', R: 'pot', P: 'pot', E: 'eyes' };
const FILLS: Record<string, string> = scion.fills;

export const MASCOT_COLUMNS = scion.sprite[0]?.length ?? 0;
export const MASCOT_ROWS = scion.sprite.length;

export const SCION_CELLS: ReadonlyArray<{ x: number; y: number; fill: string; part: ScionPart }> = scion.sprite.flatMap((row, y) =>
  [...row].flatMap((cell, x) => {
    const fill = FILLS[cell];
    const part = PART[cell];
    return fill && part ? [{ x, y, fill: `var(--g-mascot-${fill})`, part }] : [];
  })
);

export function scionRects(part?: ScionPart) {
  return SCION_CELLS.filter((c) => part === undefined || c.part === part).map((c) => (
    <rect key={`${String(c.x)}-${String(c.y)}`} x={c.x} y={c.y} width={1} height={1} fill={c.fill} />
  ));
}

export function Mascot({ pixel = 3, className }: { pixel?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={MASCOT_COLUMNS * pixel}
      height={MASCOT_ROWS * pixel}
      viewBox={`0 0 ${String(MASCOT_COLUMNS)} ${String(MASCOT_ROWS)}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {scionRects()}
    </svg>
  );
}
