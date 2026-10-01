import { dataHandling } from '@shared/privacy';
import { useApp } from '../../stores/app';
import { handlingText } from '../privacy/privacyText';
import { Group, saveSettings, SettingRow, SwitchRow } from './common';

/** Model training, incognito chats, and where each provider sends what you type. */
export function PrivacySection() {
  const settings = useApp((s) => s.settings);
  const providers = useApp((s) => s.providers);
  if (!settings) return null;
  const { noTraining, incognitoLocalOnly } = settings.privacy;
  return (
    <div className="flex flex-col gap-24">
      <Group title="Model training">
        <SwitchRow
          label="Ask providers not to train on my data"
          description="OpenRouter then uses only providers that don't store or train on prompts, so some models (often free ones) stop working. OpenAI is told not to store responses. Other providers follow their own terms, listed below."
          checked={noTraining}
          onChange={(on) => saveSettings({ privacy: { noTraining: on } })}
        />
      </Group>

      <Group title="Incognito chats" description="Start one with the ghost button on the Chat home.">
        <ul className="flex list-disc flex-col gap-4 py-10 pr-14 pl-32 text-sm text-fg-secondary">
          <li>Graft never saves them: the chat stays in memory and is gone when you delete it or quit.</li>
          <li>The title comes from your first message on this computer; no extra request names it.</li>
          <li>Your profile name isn’t sent, and notifications don’t show the chat’s text.</li>
          <li>OpenRouter uses only providers that keep no data at all (zero data retention).</li>
        </ul>
        <SwitchRow
          label="Use only models on this computer"
          description="Then nothing from an incognito chat leaves this computer. Needs Ollama, LM Studio or another local server."
          checked={incognitoLocalOnly}
          onChange={(on) => saveSettings({ privacy: { incognitoLocalOnly: on } })}
        />
      </Group>

      <Group title="Your providers" description="Where your messages go, as far as Graft can tell.">
        {providers.length === 0 ? (
          <p className="px-14 py-10 text-sm text-fg-muted">No providers yet.</p>
        ) : (
          providers.map((p) => <SettingRow key={p.id} label={p.label} description={handlingText(dataHandling(p), p.label, { incognito: false, noTraining })} />)
        )}
      </Group>
    </div>
  );
}
