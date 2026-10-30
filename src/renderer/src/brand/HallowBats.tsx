import { useApp } from '../stores/app';
import './brand.css';

/**
 * The Hallow palette's bats: three pixel bats that drift above the top of a home page, flapping
 * by swapping two frames like Scion does. Decoration only: hidden from assistive technology,
 * never in the way of a click, still when motion is reduced, and drawn only under Hallow.
 */
const UP = ['X...X.X...X', 'XX..XXX..XX', 'XXXXEXEXXXX', '.X.XXXXX.X.', '.....X.....'];
const DOWN = ['....X.X....', '....XXX....', '.XXXEXEXXX.', 'XXXXXXXXXXX', 'X.X.....X.X'];
const COLUMNS = UP[0]!.length;
const ROWS = UP.length;

function cells(rows: string[]) {
  return rows.flatMap((row, y) =>
    [...row].flatMap((cell, x) =>
      cell === '.' ? [] : [<rect key={`${String(x)}-${String(y)}`} x={x} y={y} width={1} height={1} className={cell === 'E' ? 'hallow-bat__eye' : undefined} />]
    )
  );
}

const BATS = [
  { pixel: 3, className: 'hallow-bat--one' },
  { pixel: 2, className: 'hallow-bat--two' },
  { pixel: 2, className: 'hallow-bat--three' }
];

export function HallowBats() {
  const hallow = useApp((s) => s.settings?.appearance.palette === 'hallow');
  if (!hallow) return null;
  return (
    <div className="hallow-sky" aria-hidden="true">
      {BATS.map((bat) => (
        <svg key={bat.className} className={`hallow-bat ${bat.className}`} width={COLUMNS * bat.pixel} height={ROWS * bat.pixel} viewBox={`0 0 ${String(COLUMNS)} ${String(ROWS)}`} shapeRendering="crispEdges">
          <g className="hallow-bat__up">{cells(UP)}</g>
          <g className="hallow-bat__down">{cells(DOWN)}</g>
        </svg>
      ))}
    </div>
  );
}
