import type { McpServerView } from '@shared/schemas/customize';
import { brandOf, inkOn, type BrandedServer } from '../lib/brands';
import { cn } from '../lib/cn';
import { Avatar } from './Avatar';

const STATE_DOT: Record<McpServerView['state'], string> = {
  connected: 'bg-success',
  connecting: 'bg-amber motion-pulse',
  failed: 'bg-danger',
  'needs-auth': 'bg-amber',
  untrusted: 'bg-amber',
  disabled: 'bg-fg-faint',
  idle: 'bg-fg-faint'
};

/**
 * The mark of the app a connector reaches: the icon the server gave itself, else
 * the app's own mark on its brand color, else its first letter. With `state`, a
 * dot at its corner says whether it is connected.
 */
export function ConnectorIcon({ server, size = 20, state, className }: { server: BrandedServer & { icon?: string | null }; size?: number; state?: McpServerView['state']; className?: string }) {
  const brand = server.icon ? null : brandOf(server);
  const radius = Math.round(size * 0.28);
  const mark = server.icon ? (
    <img src={server.icon} alt="" aria-hidden="true" draggable={false} style={{ width: size, height: size, borderRadius: radius }} className="shrink-0 object-contain" />
  ) : brand ? (
    <span
      aria-hidden="true"
      title={brand.title}
      className="flex shrink-0 items-center justify-center shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]"
      style={{ width: size, height: size, borderRadius: radius, background: `#${brand.hex}` }}
    >
      <svg viewBox="0 0 24 24" width={Math.round(size * 0.62)} height={Math.round(size * 0.62)} fill={inkOn(brand.hex)}>
        <path d={brand.path} />
      </svg>
    </span>
  ) : (
    <Avatar name={server.name} size={size} />
  );
  if (!state) return <span className={cn('inline-flex shrink-0', className)}>{mark}</span>;
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      {mark}
      <span aria-hidden="true" className={cn('absolute -right-2 -bottom-2 size-8 rounded-full border-2 border-[var(--g-surface-raised)]', STATE_DOT[state])} />
    </span>
  );
}
