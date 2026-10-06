import { useMemo, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import type { CustomModel, ModelInfo, ProviderSummary } from '@shared/schemas/models';
import { Button, IconButton } from '../../components/Button';
import { Checkbox, TextField } from '../../components/Field';
import { ErrorState, LoadingState } from '../../components/States';
import { errorText, invoke } from '../../lib/ipc';
import { findModel, useApp } from '../../stores/app';
import { defaultLevels, EffortChoice } from '../models/EffortChoice';
import { allModelsOf } from '../models/modelChoice';
import { ModelListbox } from '../models/ModelListbox';
import { AgentsSettings } from './AgentsSettings';
import { Group, saveSettings, SettingRow, SwitchRow } from './common';

function parseCount(text: string, min: number, max: number): number | undefined | null {
  const t = text.trim().replace(/[_,\s]/g, '');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** Model IDs the provider's list call doesn't return (fine-tunes, new releases, local servers). */
function CustomModels({ provider }: { provider: ProviderSummary }) {
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [context, setContext] = useState('');
  const [vision, setVision] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (next: CustomModel[]): Promise<boolean> => {
    setBusy(true);
    try {
      await invoke('providers:update', { id: provider.id, customModels: next });
      await useApp.getState().loadModels(true);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (): Promise<void> => {
    const modelId = id.trim();
    if (!modelId) return;
    if (provider.customModels.some((m) => m.id === modelId)) {
      setError('That model ID is already listed.');
      return;
    }
    const contextWindow = parseCount(context, 1024, 10_000_000);
    if (contextWindow === null) {
      setError('Context window must be a whole number of tokens between 1,024 and 10,000,000.');
      return;
    }
    const model: CustomModel = { id: modelId, ...(label.trim() ? { label: label.trim() } : {}), ...(contextWindow ? { contextWindow } : {}), ...(vision ? { vision } : {}) };
    if (await save([...provider.customModels, model])) {
      setId('');
      setLabel('');
      setContext('');
      setVision(false);
      setError(null);
    }
  };

  return (
    <div className="flex flex-col gap-8 px-14 py-10">
      <p className="text-base text-fg">{provider.label}</p>
      {provider.customModels.length > 0 ? (
        <ul aria-label={`Custom models for ${provider.label}`} className="flex flex-col gap-4">
          {provider.customModels.map((m) => (
            <li key={m.id} className="flex items-center gap-8 rounded-md bg-surface px-10 py-4">
              <span className="selectable min-w-0 flex-1 truncate font-mono text-sm text-fg">{m.id}</span>
              <span className="truncate text-sm text-fg-muted">
                {[m.label, m.contextWindow ? `${m.contextWindow.toLocaleString()} tokens` : null, m.vision ? 'images' : null].filter(Boolean).join(' · ')}
              </span>
              <IconButton label={`Remove ${m.id}`} size="xs" disabled={busy} onClick={() => void save(provider.customModels.filter((x) => x.id !== m.id))}>
                <Trash2 className="size-12" />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="grid grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto] items-end gap-8"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <TextField label="Model ID" value={id} placeholder="model-id" spellCheck={false} inputClassName="font-mono text-sm" onChange={(e) => setId(e.target.value)} />
        <TextField label="Display name" value={label} placeholder="Optional" onChange={(e) => setLabel(e.target.value)} />
        <TextField label="Context window" value={context} placeholder="Tokens" inputMode="numeric" onChange={(e) => setContext(e.target.value)} />
        <Button type="submit" variant="secondary" disabled={busy || id.trim().length === 0}>
          Add
        </Button>
        <Checkbox label="Accepts images" checked={vision} onChange={(e) => setVision(e.target.checked)} className="col-span-4" />
      </form>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ModelsSection() {
  const settings = useApp((s) => s.settings);
  const providers = useApp((s) => s.providers);
  const groups = useApp((s) => s.models);
  const models = useMemo(() => allModelsOf(groups), [groups]);
  const loading = useApp((s) => s.modelsLoading);
  const loadError = useApp((s) => s.modelsError);
  const current = useApp((s) => findModel(s, s.settings?.defaults.model));
  if (!settings) return null;
  const defaults = settings.defaults;
  const effortModel: ModelInfo | null = current ?? null;
  const effort = effortModel?.effort && !defaultLevels(effortModel).includes(defaults.effort) ? effortModel.effort.default : defaults.effort;

  const chooseModel = (model: ModelInfo): void => {
    const nextEffort = model.effort && !defaultLevels(model).includes(defaults.effort) ? model.effort.default : defaults.effort;
    saveSettings({ defaults: { model: model.ref, effort: nextEffort } }, "Couldn't change the default model");
  };

  return (
    <div className="flex flex-col gap-24">
      <Group
        title="Default model"
        description="New sessions and chats start with this model. Each session can switch."
        actions={
          <Button size="sm" variant="ghost" leading={<RefreshCw className="size-12" />} disabled={loading} onClick={() => void useApp.getState().loadModels(true)}>
            Refresh list
          </Button>
        }
      >
        <div className="p-10">
          {loading && models.length === 0 ? <LoadingState label="Loading models…" className="py-16" /> : null}
          {loadError && models.length === 0 ? <ErrorState title="Couldn't load models" message={loadError} onRetry={() => void useApp.getState().loadModels(true)} className="py-16" /> : null}
          {models.length > 0 ? <ModelListbox models={models} value={defaults.model} onChange={chooseModel} label="Default model" className="max-h-[280px]" /> : null}
          {!loading && !loadError && models.length === 0 ? <p className="px-4 py-8 text-base text-fg-muted">No models yet. Add a provider first.</p> : null}
        </div>
        {effortModel?.effort ? (
          <SettingRow label="Default effort" description="Higher effort thinks longer and is more thorough, but slower and uses more tokens.">
            <EffortChoice model={effortModel} value={effort} onChange={(level) => saveSettings({ defaults: { effort: level } })} />
          </SettingRow>
        ) : null}
      </Group>

      <Group title="Sessions">
        <SwitchRow
          label="Start code sessions in a new worktree"
          description="Each session gets its own branch and folder, so parallel sessions never touch the same files."
          checked={defaults.useWorktree}
          onChange={(useWorktree) => saveSettings({ defaults: { useWorktree } })}
        />
        <SwitchRow
          label="Compact automatically"
          description="Summarize older turns when a conversation nears the model's context limit."
          checked={settings.behavior.autoCompact}
          onChange={(autoCompact) => saveSettings({ behavior: { autoCompact } })}
        />
      </Group>

      <AgentsSettings models={models} />

      <Group title="Custom model IDs" description="Add models a provider doesn't list, such as fine-tunes or models on a local server.">
        {providers.length === 0 ? <p className="px-14 py-12 text-base text-fg-muted">Add a provider first.</p> : null}
        {providers.map((p) => (
          <CustomModels key={p.id} provider={p} />
        ))}
      </Group>
    </div>
  );
}
