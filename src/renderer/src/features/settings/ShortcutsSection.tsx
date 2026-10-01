import { useState, type KeyboardEvent } from 'react';
import { DEFAULT_SHORTCUTS, SHORTCUT_IDS, type ShortcutId } from '@shared/schemas/appSettings';
import { Kbd } from '../../components/Badge';
import { Button } from '../../components/Button';
import { cn } from '../../lib/cn';
import { acceleratorFromEvent, displayAccelerator, sameAccelerator, SHORTCUT_DESCRIPTIONS, shortcutProblem } from '../../lib/shortcuts';
import { useApp } from '../../stores/app';
import { Group, saveSettings } from './common';

function ShortcutRow({ id, current }: { id: ShortcutId; current: Record<ShortcutId, string> }) {
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const value = current[id];
  const isDefault = sameAccelerator(value, DEFAULT_SHORTCUTS[id]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && id !== 'interrupt') {
      setRecording(false);
      setProblem(null);
      return;
    }
    const accel = acceleratorFromEvent(event.nativeEvent);
    if (!accel) return;
    const issue = shortcutProblem(id, accel, current);
    if (issue) {
      setProblem(`${displayAccelerator(accel)}: ${issue}`);
      return;
    }
    setProblem(null);
    setRecording(false);
    saveSettings({ shortcuts: { [id]: accel } }, "Couldn't save the shortcut");
  };

  return (
    <li className="flex flex-col gap-4 px-14 py-8">
      <div className="flex min-h-[28px] items-center gap-12">
        <span className="min-w-0 flex-1 text-base text-fg">{SHORTCUT_DESCRIPTIONS[id]}</span>
        <Kbd>{displayAccelerator(value)}</Kbd>
        <Button
          size="sm"
          variant={recording ? 'outline' : 'ghost'}
          aria-label={recording ? `Press the new shortcut for ${SHORTCUT_DESCRIPTIONS[id]}` : `Change shortcut for ${SHORTCUT_DESCRIPTIONS[id]}`}
          onClick={() => {
            setRecording(!recording);
            setProblem(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setRecording(false)}
          className={cn('w-[96px]', recording && 'border-focus text-fg-strong')}
        >
          {recording ? 'Press keys…' : 'Change'}
        </Button>
        <Button size="sm" variant="ghost" disabled={isDefault} onClick={() => saveSettings({ shortcuts: { [id]: DEFAULT_SHORTCUTS[id] } })}>
          Reset
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      ) : null}
    </li>
  );
}

export function ShortcutsSection() {
  const shortcuts = useApp((s) => s.settings?.shortcuts);
  if (!shortcuts) return null;
  const current = { ...DEFAULT_SHORTCUTS, ...shortcuts };
  const allDefault = SHORTCUT_IDS.every((id) => sameAccelerator(current[id], DEFAULT_SHORTCUTS[id]));

  return (
    <div className="flex flex-col gap-24">
      <Group
        description="Click Change, then press the new combination. Esc cancels. Number keys 1–9 always pick options in menus and question cards."
        actions={
          <Button size="sm" variant="ghost" disabled={allDefault} onClick={() => saveSettings({ shortcuts: { ...DEFAULT_SHORTCUTS } })}>
            Reset all
          </Button>
        }
      >
        <ul aria-label="Shortcuts" className="flex flex-col divide-y divide-border-subtle">
          {SHORTCUT_IDS.map((id) => (
            <ShortcutRow key={id} id={id} current={current} />
          ))}
        </ul>
      </Group>
    </div>
  );
}
