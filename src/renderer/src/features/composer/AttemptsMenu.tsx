import { useState } from 'react';
import { Layers } from 'lucide-react';
import { ATTEMPTS_MAX, ATTEMPTS_MIN } from '@shared/schemas/attempts';
import type { PermissionMode } from '@shared/schemas/common';
import type { ModelInfo } from '@shared/schemas/models';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/Popover';
import { Segmented } from '../../components/Segmented';
import { Tooltip } from '../../components/Tooltip';
import { cn } from '../../lib/cn';
import { useApp } from '../../stores/app';
import { useBranches } from '../home/ContextChips';
import { resolveModel } from '../models/modelChoice';
import { attemptsUnavailable, useAttemptsChoice } from './attemptsChoice';
import { ModelQuickMenu } from './ModelQuickMenu';

const COUNTS = [
  { value: '1', label: 'Off' },
  ...Array.from({ length: ATTEMPTS_MAX - ATTEMPTS_MIN + 1 }, (_, i) => ({ value: String(ATTEMPTS_MIN + i), label: String(ATTEMPTS_MIN + i) }))
];

/** Why the next message of a session can't go as attempts, or null when it can (see attemptsUnavailable). */
export function useAttemptsUnavailable(folder: string | null, mode: PermissionMode): string | null {
  return attemptsUnavailable(folder, useBranches(folder), mode);
}

interface AttemptsMenuProps {
  /** The message box the choice belongs to. */
  draftKey: string;
  /** The session's model: every attempt uses it unless another is picked. */
  model: ModelInfo | null;
  /** Why attempts are off here (see useAttemptsUnavailable); null when they can be used. */
  unavailable: string | null;
}

/**
 * The attempts control under a code session's message box: send the next message once, or as 2 to 4 attempts
 * that each work in a private checkout, with a model per attempt. Where that can't work it stays off and says why.
 */
export function AttemptsMenu({ draftKey, model, unavailable }: AttemptsMenuProps) {
  const choice = useAttemptsChoice((s) => s.choices[draftKey]);
  const groups = useApp((s) => s.models);
  const [open, setOpen] = useState(false);
  const count = unavailable === null ? (choice?.count ?? 1) : 1;
  const on = count > 1;
  const trigger = (
    <button
      type="button"
      aria-label={unavailable === null ? `Attempts: ${on ? String(count) : 'off'}` : `Attempts: off. ${unavailable}`}
      aria-disabled={unavailable === null ? undefined : true}
      className={cn(
        'inline-flex h-22 items-center gap-4 rounded-md px-6 text-base transition-ui data-[state=open]:bg-hover',
        unavailable !== null ? 'cursor-default text-fg-faint' : on ? 'text-link hover:bg-hover' : 'text-fg-tertiary hover:bg-hover hover:text-fg'
      )}
    >
      <Layers className="size-14" aria-hidden="true" />
      {on ? <span className="tabular-nums">{`×${String(count)}`}</span> : null}
    </button>
  );
  if (unavailable !== null) return <Tooltip content={unavailable}>{trigger}</Tooltip>;
  const modelAt = (i: number): ModelInfo | null => {
    const picked = choice?.models[i] ?? null;
    return picked ? (resolveModel(groups, picked) ?? model) : model;
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={on ? `Send as ${String(count)} attempts` : 'Send as attempts'}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      </Tooltip>
      <PopoverContent side="top" align="start" className="flex w-[300px] flex-col gap-10 p-12" aria-label="Send as attempts">
        <div>
          <p className="text-md font-medium text-fg-strong">Send as attempts</p>
          <p className="mt-2 text-sm text-fg-muted">Each attempt works on your next message in a private checkout. You compare them, then apply one.</p>
        </div>
        <Segmented variant="composer" label="Attempts" value={String(count)} options={COUNTS} onChange={(value) => useAttemptsChoice.getState().setCount(draftKey, Number(value))} />
        {on ? (
          <ul className="flex flex-col gap-2" aria-label="Model of each attempt">
            {Array.from({ length: count }, (_, i) => (
              <li key={i} className="flex h-26 items-center gap-8">
                <span className="w-72 shrink-0 text-sm text-fg-secondary">{`Attempt ${String(i + 1)}`}</span>
                <ModelQuickMenu
                  current={modelAt(i)}
                  label={`Model for attempt ${String(i + 1)}`}
                  onSelect={(picked) => useAttemptsChoice.getState().setModel(draftKey, i, picked.ref)}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
