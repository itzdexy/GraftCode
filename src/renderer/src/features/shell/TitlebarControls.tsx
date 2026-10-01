import { ArrowLeft, ArrowRight, Code, Keyboard, Info, Menu as MenuIcon, MessagesSquare, PanelLeft, Plus, Search, Settings } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/Menu';
import { Segmented } from '../../components/Segmented';
import { cn } from '../../lib/cn';
import { useShortcutLabel } from '../../lib/shortcuts';
import { useApp } from '../../stores/app';
import { useNav } from '../../stores/nav';
import { useSessions } from '../../stores/sessions';
import { reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { needsAttention } from './sessionLists';
import { openSettings, startNew, setMode, toggleSidebar } from './shellActions';

/** Hamburger, sidebar toggle, back/forward and the Chat|Code toggle. */
export function TitlebarControls({ showModeToggle = true, className }: { showModeToggle?: boolean; className?: string }) {
  const mode = useApp((s) => s.settings?.ui.mode ?? 'code');
  const collapsed = useApp((s) => s.settings?.ui.sidebarCollapsed ?? false);
  const canBack = useNav((s) => s.back.length > 0);
  const canForward = useNav((s) => s.forward.length > 0);
  const attention = useSessions((s) => {
    let chat = false;
    let code = false;
    for (const summary of Object.values(s.summaries)) {
      if (summary.archived || !needsAttention(summary)) continue;
      if (summary.kind === 'chat') chat = true;
      else code = true;
    }
    return chat ? (code ? 'both' : 'chat') : code ? 'code' : 'none';
  });
  const newLabel = useShortcutLabel('newSession');
  const searchLabel = useShortcutLabel('search');
  const sidebarLabel = useShortcutLabel('toggleSidebar');
  const settingsLabel = useShortcutLabel('openSettings');

  return (
    <div className={cn('flex items-center gap-4', className)}>
      <Menu>
        <MenuTrigger asChild>
          <IconButton label="Menu" tooltip={false}>
            <MenuIcon className="size-16" />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="start" className="min-w-[220px]">
          <MenuItem icon={<Plus className="size-14" />} shortcut={newLabel} onSelect={() => startNew()}>
            {mode === 'code' ? 'New session' : 'New chat'}
          </MenuItem>
          <MenuItem icon={<Search className="size-14" />} shortcut={searchLabel} onSelect={() => useUi.getState().setSearchOpen(true)}>
            Search
          </MenuItem>
          <MenuItem icon={<PanelLeft className="size-14" />} shortcut={sidebarLabel} onSelect={() => void toggleSidebar()}>
            {collapsed ? 'Show sidebar' : 'Hide sidebar'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Settings className="size-14" />} shortcut={settingsLabel} onSelect={() => openSettings()}>
            Settings
          </MenuItem>
          <MenuItem icon={<Keyboard className="size-14" />} onSelect={() => useUi.getState().setDialog('shortcuts')}>
            Keyboard shortcuts
          </MenuItem>
          <MenuItem icon={<Info className="size-14" />} onSelect={() => useUi.getState().setDialog('about')}>
            About Graft
          </MenuItem>
        </MenuContent>
      </Menu>
      <span className="relative inline-flex">
        <IconButton label={collapsed ? 'Show sidebar' : 'Hide sidebar'} shortcut={sidebarLabel} onClick={() => void toggleSidebar()}>
          <PanelLeft className="size-16" />
        </IconButton>
        {collapsed && attention !== 'none' ? (
          <span className="pointer-events-none absolute top-3 right-3 size-6 rounded-full bg-blue" aria-hidden="true" />
        ) : null}
      </span>
      <IconButton label="Back" disabled={!canBack} onClick={() => useNav.getState().goBack()}>
        <ArrowLeft className="size-16" />
      </IconButton>
      <IconButton label="Forward" disabled={!canForward} onClick={() => useNav.getState().goForward()}>
        <ArrowRight className="size-16" />
      </IconButton>
      {showModeToggle ? (
        <Segmented
          variant="titlebar"
          label="Mode"
          value={mode}
          className="ml-auto"
          onChange={(next) => void setMode(next).catch((e: unknown) => reportError("Couldn't switch modes", e))}
          options={[
            {
              value: 'chat',
              label: 'Chat',
              icon: <MessagesSquare className="size-14" />,
              dot: mode !== 'chat' && (attention === 'chat' || attention === 'both')
            },
            {
              value: 'code',
              label: 'Code',
              icon: <Code className="size-14" />,
              dot: mode !== 'code' && (attention === 'code' || attention === 'both')
            }
          ]}
        />
      ) : null}
    </div>
  );
}
