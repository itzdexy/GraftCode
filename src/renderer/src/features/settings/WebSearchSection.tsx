import { useState } from 'react';
import type { SearchEngineSetting } from '@shared/schemas/appSettings';
import type { SearchStatus } from '@shared/ipc/contracts';
import { Button } from '../../components/Button';
import { TextField } from '../../components/Field';
import { ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { errorText, invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { useApp } from '../../stores/app';
import { useToasts } from '../../stores/toasts';
import { Group, saveSettings, SwitchRow } from './common';

const ENGINE_LABEL: Record<Exclude<SearchEngineSetting, 'auto' | 'off'>, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  brave: 'Brave Search',
  tavily: 'Tavily',
  searxng: 'SearXNG'
};

const OPTIONS: Array<{ value: SearchEngineSetting; label: string; description: string }> = [
  { value: 'auto', label: 'Automatic', description: 'A search key or SearXNG server you set up, else the search of the provider your default model uses.' },
  { value: 'openrouter', label: 'OpenRouter', description: 'Its web plugin with your OpenRouter key: about a cent per search.' },
  { value: 'anthropic', label: 'Anthropic', description: 'Claude’s web search with your Anthropic key: about a cent per search, plus tokens.' },
  { value: 'openai', label: 'OpenAI', description: 'The Responses API’s web search with your OpenAI key, billed per search.' },
  { value: 'gemini', label: 'Google Gemini', description: 'Grounding with Google Search with your Gemini key: a free daily allowance, then billed.' },
  { value: 'brave', label: 'Brave Search', description: 'An independent search index. Needs a Brave Search API key.' },
  { value: 'tavily', label: 'Tavily', description: 'Search made for AI agents. Needs a Tavily API key.' },
  { value: 'searxng', label: 'SearXNG', description: 'Your own SearXNG server, with JSON output turned on.' },
  { value: 'off', label: 'Off', description: 'Only models with a built-in search (Claude on Anthropic) can search.' }
];

function isProviderOption(value: SearchEngineSetting): value is keyof SearchStatus['providers'] {
  return value === 'openrouter' || value === 'anthropic' || value === 'openai' || value === 'gemini';
}

/** Save or remove a search API key; the key goes to the main process and never comes back. */
function KeyField({ engine, stored, onSaved }: { engine: 'brave' | 'tavily'; stored: boolean; onSaved: (status: SearchStatus) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (key: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await invoke('search:setKey', { engine, key }));
      setValue('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-end gap-8 pt-6">
      <TextField
        type="password"
        autoComplete="off"
        spellCheck={false}
        label={`${ENGINE_LABEL[engine]} API key`}
        placeholder={stored ? 'Saved — paste a new key to replace it' : 'Paste your key'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        error={error}
        className="min-w-0 flex-1"
      />
      <Button size="md" variant="secondary" disabled={busy || value.trim().length < 8} onClick={() => void save(value.trim())}>
        Save
      </Button>
      {stored ? (
        <Button size="md" variant="ghost" disabled={busy} onClick={() => void save(null)}>
          Remove
        </Button>
      ) : null}
    </div>
  );
}

function SearxField({ url }: { url: string | null }) {
  const [value, setValue] = useState(url ?? '');
  const valid = value.trim() === '' || /^https?:\/\/\S+$/.test(value.trim());
  return (
    <div className="flex items-end gap-8 pt-6">
      <TextField
        label="SearXNG address"
        placeholder="http://localhost:8080"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        error={valid ? null : 'Enter an http(s) address.'}
        className="min-w-0 flex-1"
      />
      <Button size="md" variant="secondary" disabled={!valid || value.trim() === (url ?? '')} onClick={() => saveSettings({ search: { searxngUrl: value.trim() || null } })}>
        Save
      </Button>
    </div>
  );
}

export function WebSearchSection() {
  const settings = useApp((s) => s.settings);
  const { load, reload } = useLoad(() => invoke('search:status'), `search:${settings?.search.engine ?? ''}:${settings?.search.searxngUrl ?? ''}`);
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [testing, setTesting] = useState(false);
  if (!settings) return null;
  if (load.status === 'loading' && !status) return <LoadingState label="Loading web search" />;
  if (load.status === 'error') return <ErrorState message={load.message} onRetry={reload} />;
  const current = status ?? (load.status === 'ready' ? load.data : null);
  if (!current) return null;
  const engine = settings.search.engine;

  const test = async (): Promise<void> => {
    setTesting(true);
    try {
      const result = await invoke('search:test');
      useToasts.getState().push({
        tone: 'success',
        title: `${ENGINE_LABEL[result.engine]} works`,
        ...(result.first ? { description: `${String(result.count)} results, first: ${result.first.title}` } : { description: 'It answered with no results.' })
      });
    } catch (e) {
      useToasts.getState().push({ tone: 'error', title: 'Search failed', description: errorText(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex flex-col gap-24">
      <Group title="Web access">
        <SwitchRow
          label="Let models search and read the web"
          description="Chats search and open pages on their own. Code sessions ask first in Ask mode. Incognito chats never use the web."
          checked={settings.behavior.webSearch}
          onChange={(webSearch) => saveSettings({ behavior: { webSearch } })}
        />
      </Group>

      <Group
        title="Search engine"
        description="Used when a model has no search of its own; Claude models on Anthropic use Anthropic's built-in search."
        actions={
          <Button size="sm" variant="secondary" disabled={testing || current.active === null} onClick={() => void test()}>
            {testing ? 'Searching…' : 'Test search'}
          </Button>
        }
      >
        <div role="radiogroup" aria-label="Search engine" className="flex flex-col divide-y divide-border-subtle">
          {OPTIONS.map((option) => {
            const selected = engine === option.value;
            return (
              <div key={option.value} className="px-14 py-10">
                <label className="flex cursor-pointer items-start gap-10">
                  <input
                    type="radio"
                    name="search-engine"
                    className="mt-3 accent-[var(--g-accent)]"
                    checked={selected}
                    onChange={() => saveSettings({ search: { engine: option.value } })}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-base text-fg">{option.label}</span>
                    <span className="mt-2 block text-sm text-fg-muted">
                      {option.description}
                      {isProviderOption(option.value) && !current.providers[option.value] ? ` Add ${ENGINE_LABEL[option.value]} as a provider first.` : ''}
                      {(option.value === 'brave' || option.value === 'tavily') && current.keys[option.value] ? ' Key saved.' : ''}
                    </span>
                  </span>
                </label>
                {selected && (option.value === 'brave' || option.value === 'tavily') ? (
                  <KeyField engine={option.value} stored={current.keys[option.value]} onSaved={setStatus} />
                ) : null}
                {selected && option.value === 'searxng' ? <SearxField url={settings.search.searxngUrl} /> : null}
              </div>
            );
          })}
        </div>
        <p className={cn('px-14 py-10 text-sm', current.active ? 'text-fg-secondary' : 'text-fg-muted')}>
          {current.active ? `Searching with ${ENGINE_LABEL[current.active]}.` : engine === 'off' ? 'Search is off.' : 'No search engine is set up yet.'}
        </p>
      </Group>
    </div>
  );
}
