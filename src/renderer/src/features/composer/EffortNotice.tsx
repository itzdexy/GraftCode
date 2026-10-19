import { useState } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import type { EffortLevel } from '@shared/schemas/common';
import { IconButton } from '../../components/Button';
import { Collapse } from '../../components/Collapse';
import { EFFORT_NOTICE_KEY, EFFORT_NOTICES, readPutAway } from './effortNoticeModel';

function putAway(levels: EffortLevel[]): void {
  try {
    localStorage.setItem(EFFORT_NOTICE_KEY, JSON.stringify(levels));
  } catch {
    // rocky: without storage the notice comes back after a restart; it is only a reminder.
  }
}

/** A short warning while a session runs at Max or Taproot; closed for good per level with its ×. */
export function EffortNotice({ level }: { level: EffortLevel | null }) {
  const [away, setAway] = useState(() => readPutAway(typeof localStorage === 'undefined' ? null : localStorage));
  const open = level !== null && EFFORT_NOTICES[level] !== undefined && !away.includes(level);
  // The words stay while the notice folds away after the level changed.
  const [last, setLast] = useState<EffortLevel | null>(open ? level : null);
  if (open && level !== last) setLast(level);
  const shown = open ? level : last;
  const text = shown ? EFFORT_NOTICES[shown] : undefined;
  return (
    <Collapse open={open}>
      {text && shown ? (
        <div role="note" aria-label="Effort" className="flex items-start gap-8 rounded-lg border border-amber/25 bg-warning-bg px-12 py-7 text-sm text-warning-fg">
          <TriangleAlert className="mt-2 size-14 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1">{text}</p>
          <IconButton
            label="Don't show this again"
            size="xs"
            onClick={() => {
              const next = [...away, shown];
              setAway(next);
              putAway(next);
            }}
          >
            <X className="size-14" />
          </IconButton>
        </div>
      ) : null}
    </Collapse>
  );
}
