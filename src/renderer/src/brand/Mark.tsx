import { MASCOT_COLUMNS, MASCOT_ROWS, ScionSvg, type ScionMotion } from './Mascot';

/**
 * Graft's mark: Scion the mascot, centered in a square box with crisp
 * pixels. Leaves, stem, pot and eyes are separate groups so they can move on
 * their own (see brand.css).
 */
const VIEW_BOX = `${String((MASCOT_COLUMNS - 12) / 2)} ${String((MASCOT_ROWS - 12) / 2)} 12 12`;

export type MarkMotion = ScionMotion;

interface MarkProps {
  size?: number;
  motion?: MarkMotion;
  /** Hops when hovered and cheers when clicked. */
  interactive?: boolean;
  className?: string;
  /** Accessible name; omit when the mark is decorative next to visible text. */
  title?: string;
}

export function Mark({ size = 20, motion = 'none', interactive = false, className, title }: MarkProps) {
  return <ScionSvg viewBox={VIEW_BOX} width={size} height={size} motion={motion} interactive={interactive} className={className} title={title} />;
}
