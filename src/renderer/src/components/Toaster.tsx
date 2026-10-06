import { CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useLingering } from '../lib/motion';
import { useToasts, type Toast } from '../stores/toasts';
import { Button, IconButton } from './Button';

const ICONS: Record<Toast['tone'], JSX.Element> = {
  info: <Info className="size-16 text-icon" aria-hidden="true" />,
  success: <CircleCheck className="size-16 text-success" aria-hidden="true" />,
  error: <TriangleAlert className="size-16 text-danger" aria-hidden="true" />
};

/**
 * Transient notices for finished or failed actions, stacked in the bottom-right
 * corner clear of page actions. They stay while the pointer rests on one, and
 * slide out when they go.
 */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  const hold = useToasts((s) => s.hold);
  const release = useToasts((s) => s.release);
  const shown = useLingering(toasts, (toast) => toast.id);
  return (
    <div className="pointer-events-none fixed right-16 bottom-16 z-[var(--g-z-toast)] flex w-[min(360px,calc(100vw-32px))] flex-col justify-end gap-8">
      {shown.map(({ item: toast, leaving }) => (
        <div
          key={toast.id}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          data-state={leaving ? 'closed' : 'open'}
          onPointerEnter={hold}
          onPointerLeave={release}
          className="graft-toast pointer-events-auto flex items-start gap-10 rounded-lg border border-border bg-surface px-12 py-10 shadow-popover"
        >
          <span className="mt-1">{ICONS[toast.tone]}</span>
          <div className="min-w-0 flex-1">
            <p className="text-base font-medium text-fg-strong">{toast.title}</p>
            {toast.description ? <p className="selectable mt-2 text-sm break-words text-fg-muted">{toast.description}</p> : null}
            {toast.action ? (
              <Button
                size="xs"
                variant="secondary"
                className="mt-8"
                onClick={() => {
                  toast.action?.run();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </Button>
            ) : null}
          </div>
          <IconButton label="Dismiss" tooltip={false} size="xs" onClick={() => dismiss(toast.id)} className="-mr-4">
            <X className="size-14" />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
