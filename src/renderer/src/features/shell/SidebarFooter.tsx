import { ChevronDown, Info, Keyboard } from 'lucide-react';
import { Avatar } from '../../components/Avatar';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../../components/Menu';
import { useApp } from '../../stores/app';
import { useUi } from '../../stores/ui';

/** Footer: avatar, name, the provider behind the default model, and the account menu. */
export function SidebarFooter() {
  const profile = useApp((s) => s.settings?.profile);
  const defaultProviderId = useApp((s) => s.settings?.defaults.model?.providerId ?? null);
  const providerLabel = useApp((s) => {
    const byModel = s.providers.find((p) => p.id === defaultProviderId);
    return (byModel ?? s.providers.find((p) => p.isDefault) ?? s.providers[0])?.label ?? 'No provider';
  });
  const name = profile?.name ?? '';

  return (
    <div className="flex h-[var(--g-status-bar-height)] shrink-0 items-center border-t border-border-subtle px-[var(--g-sidebar-inset)]">
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
          <MenuItem icon={<Keyboard className="size-14" />} onSelect={() => useUi.getState().setDialog('shortcuts')}>
            Keyboard shortcuts
          </MenuItem>
          <MenuItem icon={<Info className="size-14" />} onSelect={() => useUi.getState().setDialog('about')}>
            About Graft
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
