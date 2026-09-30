import { cn } from '../lib/cn';

const PALETTE_SIZE = 8;

/** Stable 32-bit FNV-1a hash so a name always maps to the same color. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function avatarColorIndex(name: string): number {
  return (hashString(name.trim().toLowerCase()) % PALETTE_SIZE) + 1;
}

export function initialOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '?';
  const first = [...trimmed][0] ?? '?';
  return first.toLocaleUpperCase();
}

interface AvatarProps {
  name: string;
  /** Data URL of the stored, downscaled profile picture. */
  src?: string | null;
  size?: number;
  className?: string;
}

export function Avatar({ name, src, size = 18, className }: AvatarProps) {
  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.5)) };
  if (src) {
    return <img src={src} alt="" aria-hidden="true" style={style} className={cn('shrink-0 rounded-full object-cover', className)} />;
  }
  const color = `var(--g-avatar-${avatarColorIndex(name)})`;
  return (
    <span
      aria-hidden="true"
      style={{ ...style, backgroundColor: color }}
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-[var(--g-avatar-text)]', className)}
    >
      {initialOf(name)}
    </span>
  );
}
