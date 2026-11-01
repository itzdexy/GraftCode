import { useEffect, useState } from 'react';
import { Sparkles, WandSparkles } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { Tooltip } from '../../components/Tooltip';
import { errorText, invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { useSessions } from '../../stores/sessions';
import { saveSettings } from '../settings/common';

/** The Files editor's AI in its toolbar row: Edit with AI, and suggestions as you type on or off, with their model in the tooltip. */
export function EditorAiButtons({ sessionId, file, onEdit }: { sessionId: string; file: string; onEdit: () => void }) {
  const editor = useApp((s) => s.settings?.editor);
  const session = useSessions((s) => s.summaries[sessionId]?.model);
  const [source, setSource] = useState<{ label: string | null; note: string | null } | null>(null);
  // Asked again when the session's model or the one chosen for suggestions changes.
  const models = `${session?.providerId ?? ''}/${session?.modelId ?? ''} ${editor?.suggestionModel?.providerId ?? ''}/${editor?.suggestionModel?.modelId ?? ''}`;
  useEffect(() => {
    let cancelled = false;
    invoke('editor:model', { sessionId, file })
      .then((answer) => {
        if (!cancelled) setSource(answer);
      })
      .catch((error: unknown) => {
        if (!cancelled) setSource({ label: null, note: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, file, models]);
  if (!editor) return null;
  const on = editor.suggestions;
  const tip = !on
    ? 'Suggestions as you type are off'
    : source?.label
      ? `Suggestions as you type, from ${source.label}`
      : source?.note
        ? `Suggestions as you type: ${source.note}`
        : 'Suggestions as you type';
  return (
    <>
      <IconButton label="Edit with AI" shortcut="Ctrl+I" size="xs" onClick={onEdit}>
        <WandSparkles className="size-13" />
      </IconButton>
      <Tooltip content={tip}>
        <IconButton
          label="Suggestions as you type"
          tooltip={false}
          size="xs"
          active={on}
          aria-pressed={on}
          onClick={() => saveSettings({ editor: { suggestions: !on } }, "Couldn't change suggestions as you type")}
        >
          <Sparkles className="size-13" />
        </IconButton>
      </Tooltip>
    </>
  );
}
