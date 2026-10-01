import { useState } from 'react';
import { ChevronDown, Download, Info, Keyboard, KeyRound, Settings } from 'lucide-react';
import { Avatar } from '../../components/Avatar';
import { IconButton } from '../../components/Button';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../../components/Menu';
import { invoke } from '../../lib/ipc';
import { useShortcutLabel } from '../../lib/shortcuts';
import { useApp } from '../../stores/app';
import { useUi } from '../../stores/ui';
import { ConfirmDialog } from '../settings/common';
import { openSettings } from './shellActions';

/** Shown only while an update downloads or waits for a restart; a downloaded update asks once to restart. */
function UpdateIndicator() {
  const update = useApp((s) => s.update);
  const [reopened, setReopened] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const readyVersion = update?.status === 'ready' ? (update.version ?? 'new') : null;
  // The prompt opens by itself for each newly downloaded version, and again from the icon.
  const confirm = reopened || (readyVersion !== null && readyVersion !== dismissed);
  const setConfirm = (open: boolean): void => {
    setReopened(open);
    if (!open) setDismissed(readyVersion);
  };
  if (!update || (update.status !== 'ready' && update.status !== 'downloading')) return null;
  const ready = update.status === 'ready';
  const label = ready
    ? `Restart to update to ${update.version ?? 'the new version'}`
    : `Downloading update${update.progress !== null ? ` (${Math.round(update.progress)}%)` : ''}`;
  return (
    <>
      <IconButton label={label} size="sm" className={ready ? 'text-accent' : undefined} onClick={() => (ready ? setConfirm(true) : openSettings('about'))}>
        <Download className="size-14" />
      </IconButton>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={update.version ? `Graft ${update.version} is ready` : 'An update is ready'}
        description="Restart to install it now, or keep working: it installs the next time Graft quits. Running sessions stop on restart; their history is kept."
        confirmLabel="Restart now"
        onConfirm={async () => {
          await invoke('updates:install');
        }}
      />
    </>
  );
}

/** Footer: avatar, name, the provider behind the default model, the account menu and the update indicator. */
export function SidebarFooter() {
  const profile = useApp((s) => s.settings?.profile);
  const defaultProviderId = useApp((s) => s.settings?.defaults.model?.providerId ?? null);
  const providerLabel = useApp((s) => {
    const byModel = s.providers.find((p) => p.id === defaultProviderId);
    return (byModel ?? s.providers.find((p) => p.isDefault) ?? s.providers[0])?.label ?? 'No provider';
  });
  const settingsLabel = useShortcutLabel('openSettings');
  const name = profile?.name ?? '';

  return (
    <div className="flex h-[var(--g-status-bar-height)] shrink-0 items-center gap-4 border-t border-border-subtle px-[var(--g-sidebar-inset)]">
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className="flex h-28 min-w-0 items-center gap-8 rounded-md pr-6 pl-5 text-left transition-ui hover:bg-sidebar-hover data-[state=open]:bg-sidebar-hover"
            aria-label={`Account menu for ${name}`}
          >
            <Avatar name={name} src={profile?.avatar ?? null} size={18} />
            <span className="min-w-0 truncate text-base text-fg-secondary">{name}</span>
            <span className="min-w-0 shrink truncate text-sm text-fg-faint">· {providerLabel}</span>
            <ChevronDown className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />
          </button>
        </MenuTrigger>
        <MenuContent side="top" align="start" className="min-w-[220px]">
          <MenuLabel>
            <span className="flex items-center gap-8">
              <Avatar name={name} src={profile?.avatar ?? null} size={24} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-base text-fg">{name}</span>
                <span className="truncate text-sm text-fg-muted">{providerLabel}</span>
              </span>
            </span>
          </MenuLabel>
          <MenuSeparator />
          <MenuItem icon={<Settings className="size-14" />} shortcut={settingsLabel} onSelect={() => openSettings()}>
            Settings
          </MenuItem>
          <MenuItem icon={<KeyRound className="size-14" />} onSelect={() => openSettings('providers')}>
            Providers
          </MenuItem>
          <MenuItem icon={<Keyboard className="size-14" />} onSelect={() => useUi.getState().setDialog('shortcuts')}>
            Keyboard shortcuts
          </MenuItem>
          <MenuItem icon={<Info className="size-14" />} onSelect={() => useUi.getState().setDialog('about')}>
            About Graft
          </MenuItem>
        </MenuContent>
      </Menu>
      <div className="flex-1" />
      <UpdateIndicator />
    </div>
  );
}
