import { useState } from 'react';
import { PERSONALIZATION_MAX, RESPONSE_STYLES, type ResponseStyle } from '@shared/schemas/appSettings';
import { Button } from '../../components/Button';
import { TextArea } from '../../components/Field';
import { cn } from '../../lib/cn';
import { useApp } from '../../stores/app';
import { useNav } from '../../stores/nav';
import { reportError, useToasts } from '../../stores/toasts';
import { Group, saveSettings, SettingRow } from './common';

const STYLES: Record<ResponseStyle, { label: string; description: string }> = {
  default: { label: 'Balanced', description: 'Graft decides how much to say.' },
  concise: { label: 'Concise', description: 'Short answers and brief reports.' },
  explanatory: { label: 'Explanatory', description: 'Reasons, trade-offs and context.' },
  learning: { label: 'Learning', description: 'Teaches step by step as it goes.' }
};

function Counter({ value }: { value: string }) {
  const near = value.length > PERSONALIZATION_MAX * 0.9;
  return (
    <p className={cn('text-right text-sm tabular-nums', near ? 'text-warning-fg' : 'text-fg-faint')}>
      {value.length.toLocaleString()} / {PERSONALIZATION_MAX.toLocaleString()}
    </p>
  );
}

/** Settings → Personalization: what Graft knows about the user and how it answers, sent with every non-incognito conversation. */
export function PersonalizationSection() {
  const saved = useApp((s) => s.settings?.personalization);
  const [about, setAbout] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<string | null>(null);
  if (!saved) return null;
  const aboutText = about ?? saved.about;
  const instructionsText = instructions ?? saved.instructions;
  const dirty = aboutText !== saved.about || instructionsText !== saved.instructions;

  const save = (): void => {
    useApp
      .getState()
      .updateSettings({ personalization: { about: aboutText.trim(), instructions: instructionsText.trim() } })
      .then(() => {
        setAbout(null);
        setInstructions(null);
        useToasts.getState().push({ tone: 'success', title: 'Personalization saved', description: 'New messages use it right away.' });
      })
      .catch((error: unknown) => reportError("Couldn't save personalization", error));
  };

  return (
    <div className="flex flex-col gap-24">
      <Group title="Response style" description="How Graft writes its answers in chats and code sessions.">
        <SettingRow label="Style">
          <div role="radiogroup" aria-label="Response style" className="grid grid-cols-4 gap-8">
            {RESPONSE_STYLES.map((style) => {
              const selected = saved.style === style;
              return (
                <button
                  key={style}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => saveSettings({ personalization: { style } })}
                  className={cn(
                    'flex flex-col items-start gap-2 rounded-md border px-10 py-8 text-left transition-ui',
                    selected ? 'border-accent bg-hover' : 'border-border hover:bg-hover'
                  )}
                >
                  <span className={cn('text-base', selected ? 'font-medium text-fg-strong' : 'text-fg')}>{STYLES[style].label}</span>
                  <span className="text-sm text-fg-muted">{STYLES[style].description}</span>
                </button>
              );
            })}
          </div>
        </SettingRow>
      </Group>

      <Group
        title="About you and your preferences"
        description="Sent to your model with every chat and code session, except incognito chats. Keep secrets out of it."
        actions={
          <Button size="sm" variant="primary" disabled={!dirty} onClick={save}>
            Save
          </Button>
        }
      >
        <div className="flex flex-col gap-6 px-14 py-12">
          <TextArea
            label="What should Graft know about you?"
            placeholder="Your role, what you work on, the languages and tools you use, your level of experience…"
            value={aboutText}
            maxLength={PERSONALIZATION_MAX}
            rows={4}
            onChange={(e) => setAbout(e.target.value)}
          />
          <Counter value={aboutText} />
        </div>
        <div className="flex flex-col gap-6 px-14 py-12">
          <TextArea
            label="How should Graft respond?"
            placeholder="For example: use British spelling, show code before the explanation, prefer TypeScript, always mention trade-offs…"
            value={instructionsText}
            maxLength={PERSONALIZATION_MAX}
            rows={4}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <Counter value={instructionsText} />
        </div>
      </Group>

      <p className="text-sm text-fg-muted">
        Rules for one project belong in its GRAFT.md, which code sessions read when they start.{' '}
        <button type="button" className="text-link hover:underline" onClick={() => useNav.getState().go({ name: 'settings', section: 'memory' })}>
          Open Memory
        </button>
      </p>
    </div>
  );
}
