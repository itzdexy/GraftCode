import { Mark } from '../../brand/Mark';
import { Wordmark } from '../../brand/Wordmark';

interface BootSplashProps {
  /** 0..1 real initialization progress; null hides the bar. */
  progress: number | null;
  label: string;
  /** Short splash for subsequent launches: no draw animation. */
  quick?: boolean;
}

/** Full-window splash: the mark draws itself, the wordmark fades in, then progress. */
export function BootSplash({ progress, label, quick = false }: BootSplashProps) {
  return (
    <div className="app-drag flex h-full flex-col items-center justify-center bg-bg">
      <div className="flex flex-col items-center gap-16">
        <Mark size={72} motion={quick ? 'none' : 'draw'} title="Graft" />
        <Wordmark className={quick ? 'text-[32px]' : 'graft-fade-in text-[32px] [animation-delay:760ms]'} />
      </div>
      {quick ? null : (
        <div className="mt-28 h-16 w-[160px]" aria-live="polite">
          {progress !== null ? (
            <div
              role="progressbar"
              aria-label={label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
              className="h-2 w-full overflow-hidden rounded-full bg-control"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-[var(--g-duration-base)] ease-standard"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          ) : null}
          <p className="mt-8 text-center text-sm text-fg-muted">{label}</p>
        </div>
      )}
    </div>
  );
}
