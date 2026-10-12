import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useNav, type SettingsSection } from '../../stores/nav';
import { HooksSection } from '../customize/HooksSection';
import { McpSection } from '../customize/McpSection';
import { MemorySection } from '../customize/MemorySection';
import { AboutSection } from './AboutSection';
import { AppearanceSection } from './AppearanceSection';
import { FoundSetting } from './common';
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
import { SETTINGS_GROUPS, SETTINGS_SECTIONS } from './sections';
import { searchSettings, type SettingsHit } from './settingsSearch';
import { ShortcutsSection } from './ShortcutsSection';
import { UsageSection } from './UsageSection';

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
    case 'usage':
      return <UsageSection />;
    case 'data':
      return <DataSection />;
    case 'about':
      return <AboutSection />;
  }
}

/** How long the setting a search landed on stays marked. */
const FOUND_MS = 2400;

const NAV_ITEM = 'flex min-h-28 w-full items-center gap-8 rounded-md px-8 py-4 text-left text-base transition-ui';

/**
 * The search box above the list of pages. While something is typed, what it
 * finds takes the list's place: pages, and single settings with the page
 * each is on. Enter takes the first, the arrow keys move through them.
 */
function SettingsNav({ current, onFind }: { current: SettingsSection; onFind: (hit: SettingsHit) => void }) {
  const [query, setQuery] = useState('');
  const hits = useMemo(() => searchSettings(query), [query]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const searching = query.trim().length > 0;

  const take = (hit: SettingsHit): void => {
    setQuery('');
    onFind(hit);
  };
  /** Moves the focus through the box and the hits: -1 is the box. */
  const focus = (index: number): void => {
    const buttons = list.current?.querySelectorAll('button') ?? [];
    if (index < 0 || buttons.length === 0) input.current?.focus();
    else buttons[Math.min(index, buttons.length - 1)]?.focus();
  };
  const onInputKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && hits.length > 0) {
      event.preventDefault();
      focus(0);
    } else if (event.key === 'Enter' && hits[0]) {
      event.preventDefault();
      take(hits[0]);
    } else if (event.key === 'Escape' && query.length > 0) {
      // The first Escape empties the box; only the next one is the app's.
      event.preventDefault();
      event.stopPropagation();
      setQuery('');
    }
  };
  const onHitKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focus(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focus(index - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setQuery('');
      input.current?.focus();
    }
  };

  return (
    <nav aria-label="Settings" className="flex w-[204px] shrink-0 flex-col overflow-y-auto pt-16 pr-8 pb-24 pl-16">
      <h1 className="px-8 pb-10 text-xl font-medium text-fg-strong">Settings</h1>
      <div className="relative mb-8">
        <Search className="pointer-events-none absolute top-1/2 left-8 size-13 -translate-y-1/2 text-icon-muted" aria-hidden="true" />
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKey}
          aria-label="Search settings"
          placeholder="Search settings"
          autoComplete="off"
          spellCheck={false}
          className="h-28 w-full rounded-md border border-input-border bg-input pr-8 pl-26 text-base text-fg transition-ui placeholder:text-fg-placeholder focus:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-0 [&::-webkit-search-cancel-button]:hidden"
        />
      </div>
      {searching ? (
        <>
          {/* Says how many were found to someone who cannot see the list change. */}
          <p role="status" className={hits.length > 0 ? 'sr-only' : 'px-8 py-4 text-sm text-fg-muted'}>
            {hits.length === 0 ? 'No setting matches.' : `${String(hits.length)} found`}
          </p>
          <ul ref={list} aria-label="Settings found" className="flex flex-col gap-1">
            {hits.map((hit, index) => (
              <li key={`${hit.section}:${hit.setting ?? ''}`}>
                <button type="button" onClick={() => take(hit)} onKeyDown={(event) => onHitKey(event, index)} className={cn(NAV_ITEM, 'flex-col items-start gap-0 text-fg-secondary hover:bg-hover hover:text-fg')}>
                  <span className="w-full min-w-0 break-words">{hit.setting ?? hit.page}</span>
                  <span className="text-sm text-fg-muted">{hit.setting === null ? 'Page' : hit.page}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        SETTINGS_GROUPS.map((group) => (
          <div key={group.id} role="group" aria-labelledby={`settings-group-${group.id}`} className="mb-8">
            <p id={`settings-group-${group.id}`} className="px-8 pb-2 text-xs font-medium text-fg-muted">
              {group.label}
            </p>
            <ul className="flex flex-col gap-1">
              {SETTINGS_SECTIONS.filter((page) => page.group === group.id).map(({ id, label, icon: Icon }) => {
                const active = id === current;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      aria-current={active ? 'page' : undefined}
                      onClick={() => useNav.getState().go({ name: 'settings', section: id })}
                      className={cn(NAV_ITEM, active ? 'bg-selected text-fg-strong' : 'text-fg-secondary hover:bg-hover hover:text-fg')}
                    >
                      <Icon className="size-14 shrink-0 text-icon" />
                      {label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </nav>
  );
}

/** Settings without a frame of its own: the list of pages and the page that is open. The window around it is SettingsWindow. */
export function SettingsBody({ section }: { section: SettingsSection }) {
  const info = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0]!;
  // The setting a search landed on: its row brings itself into view and stays marked for a moment.
  const [found, setFound] = useState<{ section: SettingsSection; setting: string } | null>(null);
  useEffect(() => {
    if (!found) return;
    const timer = setTimeout(() => setFound(null), FOUND_MS);
    return () => clearTimeout(timer);
  }, [found]);
  const onFind = (hit: SettingsHit): void => {
    setFound(hit.setting === null ? null : { section: hit.section, setting: hit.setting });
    useNav.getState().go({ name: 'settings', section: hit.section });
  };
  return (
    <div className="flex min-h-0 flex-1">
      <SettingsNav current={info.id} onFind={onFind} />
      {/* Keyed by section, so each one opens at its top instead of where the last one was scrolled to. */}
      <div key={info.id} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-24 pt-16 pb-40">
          <header className="mb-20">
            <h2 className="text-xl font-medium text-fg-strong">{info.label}</h2>
            <p className="mt-4 text-base text-fg-muted">{info.description}</p>
          </header>
          <div className="motion-rise">
            <FoundSetting.Provider value={found?.section === info.id ? found.setting : null}>
              <SectionBody section={info.id} />
            </FoundSetting.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}
