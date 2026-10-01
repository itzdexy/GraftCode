import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export const SELECT =
  'h-32 w-full rounded-md border border-input-border bg-input px-8 text-base text-fg outline-none focus:border-border-strong disabled:text-fg-muted';

export const MONO_AREA =
  'w-full resize-y rounded-md border border-input-border bg-input px-10 py-8 font-mono text-sm leading-[1.5] text-fg outline-none focus:border-border-strong';

export function Section({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-12">
      <header className="flex items-start gap-12">
        <div className="min-w-0 flex-1">
          <h2 className="text-md font-medium text-fg-strong">{title}</h2>
          {description ? <p className="mt-2 text-sm text-fg-muted">{description}</p> : null}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <li className={cn('flex min-h-[48px] items-center gap-10 rounded-md bg-raised px-12 py-6', className)}>{children}</li>;
}

/** Parses "KEY=value" (or "Key: value") lines; blank lines are ignored. */
export function parsePairs(text: string, separator: '=' | ':'): { pairs: Record<string, string>; error: string | null } {
  const pairs: Record<string, string> = {};
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(separator);
    if (at <= 0) return { pairs, error: `Line ${i + 1} needs ${separator === '=' ? 'NAME=value' : 'Name: value'}.` };
    pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { pairs, error: null };
}
