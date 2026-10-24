import { useMemo, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { lastLines, splitSecrets } from '@shared/secrets';
import { IconButton } from '../../components/Button';

/** The eye that uncovers what is covered and covers it again. `count` words the label where the secrets were counted. */
export function SecretsToggle({ shown, onChange, count, className }: { shown: boolean; onChange: (shown: boolean) => void; count?: number; className?: string }) {
  return (
    <IconButton
      label={shown ? 'Cover the secrets again' : count === 1 ? 'Show the covered secret' : count === undefined ? 'Show the covered secrets' : `Show the ${String(count)} covered secrets`}
      size="xs"
      aria-pressed={shown}
      onClick={() => onChange(!shown)}
      className={className}
    >
      {shown ? <EyeOff className="size-12" /> : <Eye className="size-12" />}
    </IconButton>
  );
}

/**
 * What a tool or a command printed. Keys, tokens and passwords in it are
 * covered until the eye is pressed, so a transcript can be shown or recorded
 * as it is. Only the display changes: the stored result, and what the model
 * read, keep the real text.
 *
 * `lines` shows only the last so many lines. The whole text is still given,
 * because it is folded after its secrets are found: the end of a private key
 * is not recognizable without its beginning.
 */
export function Output({ text, className, lines }: { text: string; className?: string; lines?: number }) {
  const pieces = useMemo(() => {
    const all = splitSecrets(text);
    return lines === undefined ? all : lastLines(all, lines);
  }, [text, lines]);
  const secrets = useMemo(() => pieces.filter((piece) => piece.secret).length, [pieces]);
  const [shown, setShown] = useState(false);
  if (secrets === 0) return <pre className={className}>{pieces.map((piece) => piece.text).join('')}</pre>;
  return (
    <div className="relative">
      <pre className={className}>
        {pieces.map((piece, i) =>
          piece.secret ? (
            <span key={i} className="rounded-xs bg-hover text-fg-muted" title={shown ? undefined : 'Covered: this looks like a key, a token or a password'}>
              {shown ? piece.text : piece.cover}
            </span>
          ) : (
            piece.text
          )
        )}
      </pre>
      <SecretsToggle shown={shown} onChange={setShown} count={secrets} className="absolute top-4 right-4 border border-border-card bg-surface" />
    </div>
  );
}
