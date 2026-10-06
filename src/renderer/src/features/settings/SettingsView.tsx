import { useState } from 'react';
import { cn } from '../../lib/cn';
import { useNav, type SettingsSection } from '../../stores/nav';
import { HooksSection } from '../customize/HooksSection';
import { McpSection } from '../customize/McpSection';
import { MemorySection } from '../customize/MemorySection';
import { ViewHeader } from '../shell/ViewHeader';
import { AboutSection } from './AboutSection';
import { AppearanceSection } from './AppearanceSection';
import { DataSection } from './DataSection';
import { MediaSection } from './MediaSection';
import { ModelsSection } from './ModelsSection';
import { NotificationsSection } from './NotificationsSection';
import { PersonalizationSection } from './PersonalizationSection';
import { PermissionsSection } from './PermissionsSection';
import { PrivacySection } from './PrivacySection';
import { SandboxSection } from './SandboxSection';
import { VoiceSection } from './VoiceSection';
import { WebSearchSection } from './WebSearchSection';
import { ProfileSection } from './ProfileSection';
import { ProjectPicker } from './ProjectPicker';
import { ProvidersSection } from './ProvidersSection';
import { SETTINGS_SECTIONS } from './sections';
import { ShortcutsSection } from './ShortcutsSection';

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
    case 'personalization':
      return <PersonalizationSection />;
    case 'providers':
      return <ProvidersSection />;
    case 'models':
      return <ModelsSection />;
    case 'permissions':
      return <PermissionsSection />;
    case 'sandbox':
      return <SandboxSection />;
    case 'privacy':
      return <PrivacySection />;
    case 'search':
      return <WebSearchSection />;
    case 'media':
      return <MediaSection />;
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
        {/* Keyed by section, so each one opens at its top instead of where the last one was scrolled to. */}
        <div key={info.id} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[720px] px-24 pt-4 pb-40">
            <header className="mb-20">
              <h2 className="text-xl font-medium text-fg-strong">{info.label}</h2>
              <p className="mt-4 text-base text-fg-muted">{info.description}</p>
            </header>
            <div className="motion-rise">
              <SectionBody section={info.id} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
