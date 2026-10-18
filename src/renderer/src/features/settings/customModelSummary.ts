import type { CustomModel } from '@shared/schemas/models';

/**
 * The line beside a custom model in Settings → Models: its name, context window and images, then the prompt and
 * tool-call format when one was chosen for it. A choice left on Automatic is not stored, so it is not mentioned.
 */
export function customModelSummary(m: CustomModel): string {
  return [
    m.label,
    m.contextWindow ? `${m.contextWindow.toLocaleString()} tokens` : null,
    m.vision ? 'images' : null,
    m.prompt ? `${m.prompt} prompt` : null,
    m.toolFormat === 'text' ? 'tools in text' : m.toolFormat === 'native' ? 'native tools' : null
  ]
    .filter(Boolean)
    .join(' · ');
}
