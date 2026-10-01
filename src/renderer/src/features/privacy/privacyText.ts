import { dataHandling, type DataHandling } from '@shared/privacy';
import type { ProviderSummary } from '@shared/schemas/models';

/** One sentence on where a request goes and what the provider may do with it. */
export function handlingText(handling: DataHandling, provider: string, mode: { incognito: boolean; noTraining: boolean }): string {
  switch (handling) {
    case 'local':
      return `${provider} runs on this computer, so nothing is sent over the internet.`;
    case 'routed':
      if (mode.incognito) return `${provider} sends it only to providers that keep no data at all (zero data retention).`;
      return mode.noTraining
        ? `${provider} sends it only to providers that don't train on or store prompts.`
        : `${provider} may send it to providers that store or train on prompts.`;
    case 'no-training':
      return `${provider}'s API terms say API data isn't used to train models; it may be kept for a limited time for abuse monitoring.`;
    case 'may-train':
      return "Google may use data sent with free-tier Gemini API keys to improve its products; paid-tier data isn't used that way.";
    case 'unknown':
      return `Graft can't check how ${provider} handles data. Read its privacy policy before sending anything sensitive.`;
  }
}

/** What an incognito chat with this provider's model means for the data, and whether it's blocked by "local only". */
export function incognitoNote(provider: ProviderSummary | undefined, localOnly: boolean): { text: string; blocked: boolean } {
  if (!provider) return { text: 'Pick a model to see where this chat is sent.', blocked: false };
  const handling = dataHandling(provider);
  if (localOnly && handling !== 'local') {
    return {
      text: `Incognito chats use only models on this computer, and ${provider.label} isn't one. Pick a local model, or change this in Settings → Privacy.`,
      blocked: true
    };
  }
  return { text: handlingText(handling, provider.label, { incognito: true, noTraining: true }), blocked: false };
}
