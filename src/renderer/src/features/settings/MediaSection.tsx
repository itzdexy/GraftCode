import { useState } from 'react';
import type { MediaStatus } from '@shared/ipc/contracts';
import type { ImageEngineSetting } from '@shared/schemas/appSettings';
import { Button } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';
import { TextField } from '../../components/Field';
import { ErrorState, LoadingState } from '../../components/States';
import { invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { useApp } from '../../stores/app';
import { Group, saveSettings, SelectField, SettingRow, SwitchRow } from './common';

type Provider = MediaStatus['providers'][number];

const PROVIDER_LABEL: Record<Provider, string> = { openrouter: 'OpenRouter', openai: 'OpenAI', gemini: 'Google Gemini' };

const OPTIONS: Array<{ value: ImageEngineSetting; label: string; description: string }> = [
  { value: 'auto', label: 'Automatic', description: 'ComfyUI when it is switched on below; otherwise the first provider you have a key for.' },
  { value: 'openrouter', label: 'OpenRouter', description: 'One key for GPT Image, Gemini, FLUX, Recraft (vector icons), Seedream and more. Billed per picture.' },
  { value: 'openai', label: 'OpenAI', description: 'GPT Image with your OpenAI key. Supports transparent backgrounds.' },
  { value: 'gemini', label: 'Google Gemini', description: 'Gemini’s image models with your Google AI Studio key.' },
  { value: 'comfyui', label: 'ComfyUI', description: 'Your own models on this computer. Free, private, and as good as the checkpoints you have installed.' },
  { value: 'off', label: 'Off', description: 'The agent never generates images.' }
];

function isProvider(value: ImageEngineSetting): value is Provider {
  return value === 'openrouter' || value === 'openai' || value === 'gemini';
}

/** The model for the chosen provider: typed, since providers add image models faster than a list could keep up. */
function ModelField({ engine, model, fallback }: { engine: Provider; model: string; fallback: string }) {
  const [value, setValue] = useState(model);
  return (
    <div className="flex items-end gap-8 pt-6">
      <TextField
        label="Image model"
        placeholder={fallback}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        hint={engine === 'openrouter' ? 'Any id from openrouter.ai/models with image output, e.g. black-forest-labs/flux.2-pro or recraft/recraft-v4.1-vector. Empty uses the default.' : 'Empty uses the default.'}
        className="min-w-0 flex-1"
        spellCheck={false}
      />
      <Button size="md" variant="secondary" disabled={value.trim() === model} onClick={() => saveSettings({ media: { imageModel: value.trim() } })}>
        Save
      </Button>
    </div>
  );
}

function ComfyAddress({ url }: { url: string }) {
  const [value, setValue] = useState(url);
  const valid = /^https?:\/\/\S+$/i.test(value.trim());
  return (
    <div className="flex items-end gap-8">
      <TextField
        label="ComfyUI address"
        placeholder="http://127.0.0.1:8188"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        error={valid ? null : 'Enter an http(s) address.'}
        className="min-w-0 flex-1"
        spellCheck={false}
      />
      <Button size="md" variant="secondary" disabled={!valid || value.trim() === url} onClick={() => saveSettings({ media: { comfyUrl: value.trim() } })}>
        Save
      </Button>
    </div>
  );
}

function ComfyStatus({ comfy, checkpoint }: { comfy: NonNullable<MediaStatus['comfy']>; checkpoint: string }) {
  if (!comfy.reachable) {
    return (
      <p role="alert" className="text-sm text-amber-fg">
        {comfy.error ?? 'ComfyUI isn’t answering.'}
      </p>
    );
  }
  const folders = Object.entries(comfy.modelFolders)
    .map(([folder, count]) => `${String(count)} in ${folder}`)
    .join(', ');
  return (
    <div className="flex flex-col gap-10">
      <ul className="flex flex-col gap-3 text-sm text-fg-secondary">
        <li>Connected{comfy.version ? ` to ComfyUI ${comfy.version}` : ''}{comfy.devices.length > 0 ? ` on ${comfy.devices.join(', ')}` : ''}.</li>
        <li>{folders.length > 0 ? `Models: ${folders}.` : 'No models found in ComfyUI’s standard folders.'}</li>
        <li>{comfy.video.length > 0 ? `Video nodes are installed (${comfy.video.slice(0, 4).join(', ')}${comfy.video.length > 4 ? '…' : ''}), so the agent can make clips when you ask.` : 'No video nodes found: this setup makes images only.'}</li>
        <li>
          {comfy.workflows.length > 0
            ? `Saved workflows: ${comfy.workflows.join(', ')}.`
            : 'No saved workflows. Put API-format workflow files (in ComfyUI: Workflow → Export (API)) in the comfyui folder of your Graft folder or a project’s .graft/comfyui to run them by name.'}
        </li>
      </ul>
      {comfy.checkpoints.length > 0 ? (
        <SelectField
          label="Checkpoint for plain text-to-image"
          value={checkpoint}
          onChange={(comfyCheckpoint) => saveSettings({ media: { comfyCheckpoint } })}
          options={[{ value: '', label: `First installed (${comfy.checkpoints[0] ?? ''})` }, ...comfy.checkpoints.map((name) => ({ value: name, label: name }))]}
        />
      ) : null}
    </div>
  );
}

/** Settings → Images: the image model the agent uses, and the user's own ComfyUI. */
export function MediaSection() {
  const media = useApp((s) => s.settings?.media);
  const { load, reload } = useLoad(() => invoke('media:status'), JSON.stringify(media ?? null));
  if (!media) return null;
  if (load.status === 'error') return <ErrorState message={load.message} onRetry={reload} />;
  const status = load.status === 'ready' ? load.data : null;
  if (!status) return <LoadingState label="Loading image settings" />;
  const engine = media.imageEngine;

  return (
    <div className="flex flex-col gap-24">
      <Group
        title="Image model"
        description="What the agent uses when you ask for generated images: pictures for a website, illustrations, logos. It only makes images when you ask, and each one is billed by the provider that makes it."
      >
        <div role="radiogroup" aria-label="Image model" className="flex flex-col divide-y divide-border-subtle">
          {OPTIONS.map((option) => {
            const selected = engine === option.value;
            const missing = isProvider(option.value) && !status.providers.includes(option.value);
            return (
              <div key={option.value} className="px-14 py-10">
                <label className="flex cursor-pointer items-start gap-10">
                  <input type="radio" name="image-engine" className="mt-3 accent-[var(--g-accent)]" checked={selected} onChange={() => saveSettings({ media: { imageEngine: option.value } })} />
                  <span className="min-w-0 flex-1">
                    <span className="text-base text-fg">{option.label}</span>
                    <span className="mt-2 block text-sm text-fg-muted">
                      {option.description}
                      {missing && isProvider(option.value) ? ` Add ${PROVIDER_LABEL[option.value]} as a provider first.` : ''}
                      {option.value === 'comfyui' && !media.comfyEnabled ? ' Switch it on below first.' : ''}
                    </span>
                  </span>
                </label>
                {selected && isProvider(option.value) ? <ModelField key={option.value} engine={option.value} model={media.imageModel} fallback={status.defaults[option.value] ?? ''} /> : null}
              </div>
            );
          })}
        </div>
        <p className="px-14 py-10 text-sm text-fg-secondary">
          {status.engine
            ? status.engine.engine === 'comfyui'
              ? 'Images are made by ComfyUI on this computer.'
              : `Images are made with ${status.engine.model} through ${PROVIDER_LABEL[status.engine.engine as Provider] ?? status.engine.engine}.`
            : engine === 'off'
              ? 'Image generation is off.'
              : 'No image model is set up yet: add a key for OpenRouter, OpenAI or Google in Providers, or switch on ComfyUI.'}
        </p>
      </Group>

      <Group title="ComfyUI" description="ComfyUI generates images and video with models on your own computer. Graft talks to it over its local address; nothing you generate leaves the machine.">
        <SwitchRow
          label="Use ComfyUI"
          description="Lets the agent see what you have installed and run workflows when you ask for images or video."
          checked={media.comfyEnabled}
          onChange={(comfyEnabled) => saveSettings({ media: { comfyEnabled } })}
        />
        {media.comfyEnabled ? (
          <SettingRow
            label="Connection"
            control={
              <Button size="sm" variant="secondary" onClick={reload} leading={load.status === 'loading' ? <Spinner size={12} label="Checking" /> : undefined}>
                Check again
              </Button>
            }
          >
            <div className="flex flex-col gap-12">
              <ComfyAddress key={media.comfyUrl} url={media.comfyUrl} />
              {status.comfy ? <ComfyStatus comfy={status.comfy} checkpoint={media.comfyCheckpoint} /> : <p className="text-sm text-fg-muted">Checking…</p>}
            </div>
          </SettingRow>
        ) : null}
      </Group>
    </div>
  );
}
