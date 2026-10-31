import { useId, useMemo } from 'react';
import type { ModelInfo } from '@shared/schemas/models';
import { useApp } from '../../stores/app';
import { modelKey, modelOfKey } from './agentSettings';
import { Group, saveSettings, SettingRow, SwitchRow } from './common';

const SELECT = 'h-28 w-[240px] rounded-md border border-input-border bg-input px-8 text-base text-fg outline-none focus:border-border-strong';

/** Settings → Models → Editor: suggestions as you type in the Files editor, and the model that writes them. */
export function EditorSettings({ models }: { models: ModelInfo[] }) {
  const editor = useApp((s) => s.settings?.editor);
  const providers = useApp((s) => s.providers);
  const providerLabels = useMemo(() => Object.fromEntries(providers.map((p) => [p.id, p.label])), [providers]);
  const modelId = useId();
  if (!editor) return null;
  const usable = models.filter((m) => m.availability?.selectable !== false);
  // Named by provider whenever there is more than one, as in the other model lists.
  const several = new Set(usable.map((m) => m.ref.providerId)).size > 1;
  const options = [
    { value: '', label: 'The provider’s fast model' },
    ...usable.map((m) => ({ value: modelKey(m.ref), label: several ? `${m.label} · ${providerLabels[m.ref.providerId] ?? m.ref.providerId}` : m.label }))
  ];
  const chosen = editor.suggestionModel;
  // A model chosen before and gone since stays listed, so the choice can be seen and changed.
  if (chosen && !options.some((o) => o.value === modelKey(chosen))) options.push({ value: modelKey(chosen), label: `${chosen.modelId} (no longer available)` });
  return (
    <Group title="Editor" description="Help from a model while you edit files in the Files panel. Edit with AI (Ctrl+I) uses the session’s own model.">
      <SwitchRow
        label="Suggestions as you type"
        description="Grey text appears ahead of the cursor when you pause. Tab accepts it, Ctrl+Right accepts a word, Escape dismisses it."
        checked={editor.suggestions}
        onChange={(suggestions) => saveSettings({ editor: { suggestions } })}
      />
      <SettingRow
        label="Model for suggestions"
        description="The provider’s fast model is the quickest and costs least. Any other model works too."
        labelFor={modelId}
        control={
          <select
            id={modelId}
            value={chosen ? modelKey(chosen) : ''}
            onChange={(event) => saveSettings({ editor: { suggestionModel: event.target.value ? modelOfKey(event.target.value, usable) : null } }, "Couldn't change the model for suggestions")}
            className={SELECT}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        }
      />
      <p className="px-14 py-10 text-sm text-fg-muted">
        While suggestions are on, the code around the cursor (up to 6,000 characters before it and 2,000 after) and the file’s name are sent to that model. Files that may hold keys or passwords, such as .env, are never sent, and keys found in the code are covered first.
      </p>
    </Group>
  );
}
