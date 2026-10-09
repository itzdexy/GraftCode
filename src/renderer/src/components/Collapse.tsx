import { useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { usePresence } from '../lib/motion';

/**
 * Content that opens in place: it grows to its height when `open` turns true
 * and folds back when it turns false, then leaves the page. What is already
 * open when it first renders just appears, so opening a session doesn't
 * animate everything in it.
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const present = usePresence(open);
  // Grows in only after `open` has changed at least once since it first rendered.
  const [seen, setSeen] = useState(open);
  const [toggled, setToggled] = useState(false);
  if (open !== seen) {
    setSeen(open);
    setToggled(true);
  }
  if (!present) return null;
  return (
    <div
      className={cn('graft-collapse', toggled && 'graft-collapse--enter')}
      data-state={open ? 'open' : 'closed'}
      aria-hidden={!open || undefined}
      {...(!open ? { inert: '' } : {})}
    >
      <div className={className}>{children}</div>
    </div>
  );
}
