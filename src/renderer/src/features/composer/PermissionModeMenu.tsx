import type { PermissionMode } from '@shared/schemas/common';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '../../components/Menu';
import { cn } from '../../lib/cn';
import { PERMISSION_MODE_INFO } from '../../lib/format';
import { useShortcutLabel } from '../../lib/shortcuts';
import { useApp } from '../../stores/app';

export const CYCLE_ORDER: PermissionMode[] = ['ask', 'auto-edit', 'plan', 'auto'];

/** Next mode for Shift+Tab (Bypass is never reached by cycling). */
export function nextMode(mode: PermissionMode): PermissionMode {
  const i = CYCLE_ORDER.indexOf(mode);
  return CYCLE_ORDER[(i + 1) % CYCLE_ORDER.length] ?? 'ask';
}

interface PermissionModeMenuProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  disabled?: boolean;
}

/** The permission-mode label under the composer and its menu. */
export function PermissionModeMenu({ value, onChange, disabled = false }: PermissionModeMenuProps) {
  const bypassEnabled = useApp((s) => s.settings?.behavior.bypassModeEnabled ?? false);
  const cycle = useShortcutLabel('cyclePermissionMode');
  const modes: PermissionMode[] = bypassEnabled ? [...CYCLE_ORDER, 'bypass'] : CYCLE_ORDER;
  return (
    <Menu>
      <MenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`Permission mode: ${PERMISSION_MODE_INFO[value].label}`}
          className={cn(
            'inline-flex h-22 items-center rounded-md px-6 text-base transition-ui hover:bg-hover data-[state=open]:bg-hover disabled:text-fg-faint',
            value === 'bypass' ? 'text-danger' : value === 'plan' ? 'text-link' : 'text-fg-secondary hover:text-fg'
          )}
        >
          {PERMISSION_MODE_INFO[value].label}
        </button>
      </MenuTrigger>
      <MenuContent side="top" align="start" className="w-[300px]">
        <MenuLabel>Permission mode · {cycle} to cycle</MenuLabel>
        {modes.map((mode) => (
          <MenuItem
            key={mode}
            checked={mode === value}
            description={PERMISSION_MODE_INFO[mode].description}
            danger={mode === 'bypass'}
            onSelect={() => onChange(mode)}
          >
            {PERMISSION_MODE_INFO[mode].label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
