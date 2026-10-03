import { useEffect, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/appSettings';
import type { SpeechModel } from '@shared/ipc/contracts';
import { Button } from '../../components/Button';
import { Slider } from '../../components/Slider';
import { ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { bestSystemVoice, startSpeech, stopSpeech, useSpeech, voiceLabel } from '../../lib/speech';
import { useLoad } from '../../lib/useLoad';
import { useApp } from '../../stores/app';
import { SELECT } from '../customize/shared';
import { Group, saveSettings, SettingRow } from './common';

const SAMPLE = 'Hi! This is how Graft sounds when it reads a reply aloud. You can pause or stop it at any time.';
const SAMPLE_KEY = 'voice-settings-sample';

function price(model: SpeechModel): string {
  if (model.pricePer1kChars === null) return '';
  const cost = model.pricePer1kChars === 0 ? 'free' : `$${model.pricePer1kChars < 0.01 ? model.pricePer1kChars.toPrecision(2) : model.pricePer1kChars.toFixed(3)} per 1,000 characters`;
  return model.billsOutput ? ` · ${cost}, plus the audio` : ` · ${cost}`;
}

/** This computer's voices; Chromium loads them a moment after start. */
function useSystemVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState(() => window.speechSynthesis.getVoices());
  useEffect(() => {
    const update = (): void => setVoices(window.speechSynthesis.getVoices());
    window.speechSynthesis.addEventListener('voiceschanged', update);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', update);
  }, []);
  return voices;
}

export function VoiceSection() {
  const voice = useApp((s) => s.settings?.voice);
  const { load, reload } = useLoad(() => invoke('voice:models'), 'voice-models');
  const systemVoices = useSystemVoices();
  const sample = useSpeech((st) => (st.key === SAMPLE_KEY ? st.status : 'idle'));
  if (!voice) return null;
  if (load.status === 'loading') return <LoadingState label="Loading voices" />;
  if (load.status === 'error') return <ErrorState message={load.message} onRetry={reload} />;
  const { available, models } = load.data;
  const model = models.find((m) => m.id === voice.model) ?? null;
  const natural = voice.engine === 'natural';
  const best = bestSystemVoice(systemVoices, null);

  const pickModel = (id: string): void => {
    const next = models.find((m) => m.id === id);
    if (!next) return;
    saveSettings({ voice: { model: id, voice: next.voices.includes(voice.voice) ? voice.voice : (next.voices[0] ?? voice.voice) } });
  };

  return (
    <div className="flex flex-col gap-24">
      <Group title="Read aloud" description="The speaker button under each chat reply reads it aloud. While it reads, the same place has pause and stop.">
        <SettingRow label="Voice" description={natural ? 'A lifelike voice from OpenRouter’s speech models, paid per character with your OpenRouter key.' : 'The voices built into your computer: free and offline.'}>
          <div role="radiogroup" aria-label="Voice" className="grid grid-cols-2 gap-8">
            {(
              [
                ['natural', 'Natural voice'],
                ['system', 'This computer’s voice']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={voice.engine === value}
                onClick={() => saveSettings({ voice: { engine: value } })}
                className={cn(
                  'flex h-36 items-center justify-center rounded-md border text-base transition-ui',
                  voice.engine === value ? 'border-border-strong bg-hover text-fg-strong' : 'border-border text-fg-secondary hover:bg-hover'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
        {natural && !available ? (
          <p className="px-14 py-6 text-sm text-warning-fg">
            Natural voices use your OpenRouter key. Add OpenRouter in Settings → Providers; until then Graft reads with this computer’s voice.
          </p>
        ) : null}
        {natural ? (
          <>
            <SettingRow
              label="Model"
              labelFor="voice-model"
              control={
                <select id="voice-model" className={cn(SELECT, 'w-[300px]')} value={model ? voice.model : ''} onChange={(e) => pickModel(e.target.value)}>
                  {model ? null : <option value="">{models.length === 0 ? 'No speech models found' : 'Pick a model'}</option>}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {price(m)}
                    </option>
                  ))}
                </select>
              }
            />
            <SettingRow
              label="Speaker"
              labelFor="voice-speaker"
              control={
                <select id="voice-speaker" className={cn(SELECT, 'w-[300px]')} value={voice.voice} onChange={(e) => saveSettings({ voice: { voice: e.target.value } })} disabled={!model}>
                  {(model?.voices ?? [voice.voice]).map((v) => (
                    <option key={v} value={v}>
                      {voiceLabel(v)}
                    </option>
                  ))}
                </select>
              }
            />
          </>
        ) : null}
        {!natural || !available ? (
          <SettingRow
            label={natural ? 'Voice on this computer (fallback)' : 'Voice on this computer'}
            labelFor="voice-system"
            control={
              <select id="voice-system" className={cn(SELECT, 'w-[300px]')} value={voice.systemVoice ?? ''} onChange={(e) => saveSettings({ voice: { systemVoice: e.target.value || null } })}>
                <option value="">Best available{best ? ` (${best.name})` : ''}</option>
                {systemVoices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                  </option>
                ))}
              </select>
            }
          />
        ) : null}
        <SettingRow
          label="Speed"
          control={
            <>
              <div className="w-[160px]">
                <Slider label="Speed" value={voice.speed} min={0.5} max={2} step={0.1} valueText={`${voice.speed.toFixed(1)} times`} onChange={(speed) => saveSettings({ voice: { speed: Math.round(speed * 10) / 10 } })} />
              </div>
              <span className="w-36 text-right text-sm text-fg-secondary tabular-nums">{voice.speed.toFixed(1)}×</span>
              <Button size="sm" variant="ghost" disabled={voice.speed === DEFAULT_APP_SETTINGS.voice.speed} onClick={() => saveSettings({ voice: { speed: DEFAULT_APP_SETTINGS.voice.speed } })}>
                Reset
              </Button>
            </>
          }
        />
        <SettingRow
          label="Try it"
          control={
            sample === 'idle' ? (
              <Button size="sm" variant="secondary" onClick={() => void startSpeech(SAMPLE_KEY, SAMPLE, voice, { incognito: false })}>
                <Play className="size-12" aria-hidden="true" /> Play a sample
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={stopSpeech}>
                <Square className="size-11" aria-hidden="true" /> {sample === 'loading' ? 'Preparing…' : 'Stop'}
              </Button>
            )
          }
        />
      </Group>
      <p className="text-sm text-fg-muted">
        A natural voice sends the text of each reply you play to OpenRouter and the voice’s provider. Incognito chats are always read with this computer’s voice, so their text goes nowhere.
      </p>
    </div>
  );
}
