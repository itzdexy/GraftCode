import { useState, type ComponentType } from 'react';
import { AudioLines, Bell, BookText, Cpu, Database, EyeOff, Globe, Info, Keyboard, KeyRound, Palette, Plug, ShieldCheck, User, Webhook } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useNav, type SettingsSection } from '../../stores/nav';
import { HooksSection } from '../customize/HooksSection';
import { McpSection } from '../customize/McpSection';
import { MemorySection } from '../customize/MemorySection';
import { ViewHeader } from '../shell/ViewHeader';
import { AboutSection } from './AboutSection';
import { AppearanceSection } from './AppearanceSection';
import { DataSection } from './DataSection';
import { ModelsSection } from './ModelsSection';
import { NotificationsSection } from './NotificationsSection';
import { PermissionsSection } from './PermissionsSection';
import { PrivacySection } from './PrivacySection';
import { VoiceSection } from './VoiceSection';
import { WebSearchSection } from './WebSearchSection';
import { ProfileSection } from './ProfileSection';
import { ProjectPicker } from './ProjectPicker';
import { ProvidersSection } from './ProvidersSection';
import { ShortcutsSection } from './ShortcutsSection';

interface SectionInfo {
  id: SettingsSection;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

export const SETTINGS_SECTIONS: SectionInfo[] = [
  { id: 'profile', label: 'Profile', description: 'How Graft greets you.', icon: User },
  { id: 'providers', label: 'Providers', description: 'Keys and endpoints for model providers.', icon: KeyRound },
  { id: 'models', label: 'Models', description: 'Defaults for new sessions and extra model IDs.', icon: Cpu },
  { id: 'permissions', label: 'Permissions', description: 'What the agent may do without asking.', icon: ShieldCheck },
  { id: 'privacy', label: 'Privacy', description: 'Model training, incognito chats and where your messages go.', icon: EyeOff },
  { id: 'search', label: 'Web search', description: 'How models search and read the web.', icon: Globe },
  { id: 'voice', label: 'Voice', description: 'How replies sound when they are read aloud.', icon: AudioLines },
  { id: 'mcp', label: 'MCP servers', description: 'Tools and data from other apps.', icon: Plug },
  { id: 'hooks', label: 'Hooks', description: 'Commands that run around tool calls and turns.', icon: Webhook },
  { id: 'memory', label: 'Memory', description: 'Standing instructions every session reads.', icon: BookText },
  { id: 'appearance', label: 'Appearance', description: 'Theme, text size and motion.', icon: Palette },
  { id: 'shortcuts', label: 'Shortcuts', description: 'Keyboard shortcuts.', icon: Keyboard },
  { id: 'notifications', label: 'Notifications', description: 'Desktop notifications and running in the background.', icon: Bell },
  { id: 'data', label: 'Data', description: 'Export, clear and reset.', icon: Database },
  { id: 'about', label: 'About', description: 'Version and updates.', icon: Info }
];

/** MCP, hooks and memory exist per scope; these reuse the Customize editors with a project picker. */
function ScopedSection({ render }: { render: (projectPath: string | null) => JSX.Element }) {
  const [projectPath, setProjectPath] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-16">
      <ProjectPicker value={projectPath} onChange={setProjectPath} className="self-end" />
      {render(projectPath)}
    </div>
  );
}

function SectionBody({ section }: { section: SettingsSection }) {
  switch (section) {
    case 'profile':
      return <ProfileSection />;
    case 'providers':
      return <ProvidersSection />;
    case 'models':
      return <ModelsSection />;
    case 'permissions':
      return <PermissionsSection />;
    case 'privacy':
      return <PrivacySection />;
    case 'search':
      return <WebSearchSection />;
    case 'voice':
      return <VoiceSection />;
    case 'mcp':
      return <ScopedSection render={(projectPath) => <McpSection projectPath={projectPath} />} />;
    case 'hooks':
      return <ScopedSection render={(projectPath) => <HooksSection projectPath={projectPath} />} />;
    case 'memory':
      return <ScopedSection render={(projectPath) => <MemorySection projectPath={projectPath} />} />;
    case 'appearance':
      return <AppearanceSection />;
    case 'shortcuts':
      return <ShortcutsSection />;
    case 'notifications':
      return <NotificationsSection />;
    case 'data':
      return <DataSection />;
    case 'about':
      return <AboutSection />;
  }
}

export function SettingsView({ section }: { section: SettingsSection }) {
  const info = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0]!;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader />
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings" className="flex w-[188px] shrink-0 flex-col overflow-y-auto pt-4 pr-8 pb-24 pl-16">
          <h1 className="px-8 pb-12 text-xl font-medium text-fg-strong">Settings</h1>
          <ul className="flex flex-col gap-1">
            {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => {
              const active = id === info.id;
              return (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => useNav.getState().go({ name: 'settings', section: id })}
                    className={cn(
                      'flex h-28 w-full items-center gap-8 rounded-md px-8 text-left text-base transition-ui',
                      active ? 'bg-selected text-fg-strong' : 'text-fg-secondary hover:bg-hover hover:text-fg'
                    )}
                  >
                    <Icon className="size-14 shrink-0 text-icon" />
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[720px] px-24 pt-4 pb-40">
            <header className="mb-20">
              <h2 className="text-xl font-medium text-fg-strong">{info.label}</h2>
              <p className="mt-4 text-base text-fg-muted">{info.description}</p>
            </header>
            <SectionBody key={info.id} section={info.id} />
          </div>
        </div>
      </div>
    </div>
  );
}
