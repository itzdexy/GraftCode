import { useMemo, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { coverSecret, splitSecrets } from '@shared/secrets';
import { IconButton } from '../../components/Button';

/**
 * What a tool or a command printed. Keys and tokens in it are covered until
 * the eye is pressed, so a transcript can be shown or recorded as it is.
 * Only the display changes: the stored result, and what the model read,
 * keep the real text.
 */
export function Output({ text, className }: { text: string; className?: string }) {
  const pieces = useMemo(() => splitSecrets(text), [text]);
  const secrets = useMemo(() => pieces.filter((piece) => piece.secret).length, [pieces]);
  const [shown, setShown] = useState(false);
  if (secrets === 0) return <pre className={className}>{text}</pre>;
  return (
    <div className="relative">
      <pre className={className}>
        {pieces.map((piece, i) =>
          piece.secret ? (
            <span key={i} className="rounded-xs bg-hover text-fg-muted" title={shown ? undefined : 'Covered: this looks like a key or a token'}>
              {shown ? piece.text : coverSecret(piece.text)}
            </span>
          ) : (
            piece.text
          )
        )}
      </pre>
      <IconButton
        label={shown ? 'Cover the secrets again' : secrets === 1 ? 'Show the covered secret' : `Show the ${String(secrets)} covered secrets`}
        size="xs"
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
        className="absolute top-4 right-4 border border-border-card bg-surface"
      >
        {shown ? <EyeOff className="size-12" /> : <Eye className="size-12" />}
      </IconButton>
    </div>
  );
}
