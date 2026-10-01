import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, X } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { usePanels } from '../../stores/panels';
import { reportError } from '../../stores/toasts';
import { PanelFrame } from './PanelFrame';

const QUICK = ['localhost:3000', 'localhost:5173', 'localhost:8080'];

/** Menus, popovers and dialogs that the native page view would otherwise cover (tooltips don't count). */
function blockingOverlayOpen(): boolean {
  if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return true;
  return [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].some((el) => !el.querySelector('[role="tooltip"]'));
}

function command(name: 'back' | 'forward' | 'reload' | 'stop' | 'close' | 'external'): void {
  invoke('browser:command', { command: name }).catch((error: unknown) => reportError("The browser didn't respond", error));
}

/**
 * Browser panel for local dev servers and docs. The page itself is a native
 * view main positions over the area below the address bar; it is hidden while
 * menus or dialogs are open so they stay on top.
 */
export function BrowserPanelView({ onClose }: { onClose: () => void }) {
  const state = usePanels((s) => s.browser);
  const [address, setAddress] = useState(state?.url ?? '');
  const [editing, setEditing] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const hasPage = Boolean(state?.url);
  const shownAddress = editing ? address : (state?.url ?? address);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !hasPage) return;
    let frame = 0;
    const send = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const visible = r.width > 0 && r.height > 0 && !blockingOverlayOpen();
        invoke('browser:bounds', { bounds: visible ? { x: r.left, y: r.top, width: r.width, height: r.height } : null }).catch((error: unknown) =>
          logError('Could not position the browser view', error)
        );
      });
    };
    const resize = new ResizeObserver(send);
    resize.observe(el);
    const overlays = new MutationObserver(send);
    overlays.observe(document.body, { childList: true });
    window.addEventListener('resize', send);
    send();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      overlays.disconnect();
      window.removeEventListener('resize', send);
      invoke('browser:bounds', { bounds: null }).catch((error: unknown) => logError('Could not hide the browser view', error));
    };
  }, [hasPage]);

  const go = (target: string): void => {
    setEditing(false);
    invoke('browser:navigate', { url: target })
      .then((r) => setAddress(r.url))
      .catch((error: unknown) => reportError("Couldn't open that address", error));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (address.trim()) go(address);
  };

  return (
    <PanelFrame
      label="Browser"
      onClose={() => {
        command('close');
        onClose();
      }}
      title={
        <span className="flex items-center gap-6">
          <Globe className="size-14 text-icon" aria-hidden="true" />
          <span className="truncate">{state?.title || 'Browser'}</span>
        </span>
      }
      actions={
        hasPage ? (
          <IconButton label="Open in your browser" size="xs" onClick={() => command('external')}>
            <ExternalLink className="size-14" />
          </IconButton>
        ) : null
      }
    >
      <form onSubmit={submit} className="flex h-32 shrink-0 items-center gap-2 border-b border-border-panel px-4">
        <IconButton label="Back" size="xs" disabled={!state?.canGoBack} onClick={() => command('back')}>
          <ArrowLeft className="size-14" />
        </IconButton>
        <IconButton label="Forward" size="xs" disabled={!state?.canGoForward} onClick={() => command('forward')}>
          <ArrowRight className="size-14" />
        </IconButton>
        <IconButton label={state?.loading ? 'Stop' : 'Reload'} size="xs" disabled={!hasPage} onClick={() => command(state?.loading ? 'stop' : 'reload')}>
          {state?.loading ? <X className="size-14" /> : <RotateCw className="size-14" />}
        </IconButton>
        <input
          value={shownAddress}
          onChange={(e) => {
            setEditing(true);
            setAddress(e.target.value);
          }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setEditing(false)}
          aria-label="Address"
          placeholder="localhost:3000 or https://…"
          spellCheck={false}
          className="h-24 min-w-0 flex-1 rounded-sm border border-input-border bg-input px-8 font-mono text-sm text-fg outline-none focus:border-border-strong"
        />
      </form>
      {state?.error ? (
        <p role="alert" className="selectable shrink-0 border-b border-border-panel bg-danger-bg px-10 py-4 text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {hasPage ? (
        <div ref={hostRef} className="min-h-0 flex-1 bg-surface" />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-10 px-16 text-center">
          <p className="text-base text-fg-secondary">Preview a local dev server or any web page.</p>
          <p className="text-sm text-fg-muted">Pages run isolated from Graft: no access to your files, keys or other sessions.</p>
          <div className="mt-4 flex flex-wrap justify-center gap-6">
            {QUICK.map((q) => (
              <button key={q} type="button" onClick={() => go(q)} className="h-24 rounded-sm border border-border px-8 font-mono text-sm text-fg-secondary hover:bg-hover">
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </PanelFrame>
  );
}
