/**
 * "Scion", Graft's pixel mascot: a seedling with two leaves growing from a
 * small clay pot with a face. 11×8 grid rendered as crisp SVG rects at the
 * --g-mascot-pixel scale.
 *
 * Legend: L leaf, D leaf shadow, S stem, R pot rim, P pot, E eye.
 */
const SPRITE = [
  '.LL.....LL.',
  'LLLL...LLLL',
  '.DDDS.SDDD.',
  '.....S.....',
  '.RRRRRRRRR.',
  '..PEPPPEP..',
  '..PPPPPPP..',
  '...PPPPP...'
] as const;

const FILL: Record<string, string> = {
  L: 'var(--g-mascot-leaf)',
  D: 'var(--g-mascot-leaf-dark)',
  S: 'var(--g-mascot-leaf-dark)',
  R: 'var(--g-mascot-pot-rim)',
  P: 'var(--g-mascot-pot)',
  E: 'var(--g-mascot-eye)'
};

export const MASCOT_COLUMNS = SPRITE[0].length;
export const MASCOT_ROWS = SPRITE.length;

export function Mascot({ pixel = 3, className }: { pixel?: number; className?: string }) {
  const rects: Array<{ x: number; y: number; fill: string }> = [];
  SPRITE.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      const fill = FILL[cell];
      if (fill) rects.push({ x, y, fill });
    });
  });
  return (
    <svg
      className={className}
      width={MASCOT_COLUMNS * pixel}
      height={MASCOT_ROWS * pixel}
      viewBox={`0 0 ${MASCOT_COLUMNS} ${MASCOT_ROWS}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {rects.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={1} height={1} fill={r.fill} />
      ))}
    </svg>
  );
}
