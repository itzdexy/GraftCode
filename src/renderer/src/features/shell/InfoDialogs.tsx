import { useEffect, useState } from 'react';
import type { AppInfo } from '@shared/ipc/contracts';
import { SHORTCUT_IDS, type ShortcutId } from '@shared/schemas/appSettings';
import { Kbd } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { ErrorState, LoadingState } from '../../components/States';
import { Mark } from '../../brand/Mark';
import { Wordmark } from '../../brand/Wordmark';
import { errorText, invoke } from '../../lib/ipc';
import { SHORTCUT_DESCRIPTIONS, useShortcutLabel } from '../../lib/shortcuts';
import { useApp } from '../../stores/app';
import { reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';

function ShortcutRow({ id }: { id: ShortcutId }) {
  const label = useShortcutLabel(id);
  return (
    <li className="flex h-28 items-center justify-between gap-12 text-base">
      <span className="text-fg-secondary">{SHORTCUT_DESCRIPTIONS[id]}</span>
      <Kbd>{label}</Kbd>
    </li>
  );
}

function ShortcutsBody() {
  return (
    <DialogContent title="Keyboard shortcuts" description="Change them in Settings → Shortcuts.">
      <ul className="flex flex-col">
        {SHORTCUT_IDS.map((id) => (
          <ShortcutRow key={id} id={id} />
        ))}
        <li className="flex h-28 items-center justify-between gap-12 text-base">
          <span className="text-fg-secondary">Pick an option in menus and question cards</span>
          <Kbd>1–9</Kbd>
        </li>
      </ul>
    </DialogContent>
  );
}

type InfoState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; info: AppInfo };

function AboutBody() {
  const paths = useApp((s) => s.paths);
  const [state, setState] = useState<InfoState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    invoke('app:info')
      .then((info) => {
        if (!cancelled) setState({ status: 'ready', info });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  const load = (): void => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  };
  return (
    <DialogContent title="About Graft" description="A desktop coding agent that works with your own model provider keys.">
      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'error' ? <ErrorState message={state.message} onRetry={load} /> : null}
      {state.status === 'ready' ? (
        <div className="flex flex-col gap-16">
          <div className="flex items-center gap-10">
            <Mark size={28} />
            <Wordmark className="text-xl" />
            <span className="text-base text-fg-muted">Version {state.info.version}</span>
          </div>
          <dl className="selectable grid grid-cols-[auto_1fr] gap-x-16 gap-y-4 text-sm">
            <dt className="text-fg-muted">Electron</dt>
            <dd className="text-fg-secondary">{state.info.versions.electron}</dd>
            <dt className="text-fg-muted">Chromium</dt>
            <dd className="text-fg-secondary">{state.info.versions.chrome}</dd>
            <dt className="text-fg-muted">Node.js</dt>
            <dd className="text-fg-secondary">{state.info.versions.node}</dd>
            {paths ? (
              <>
                <dt className="text-fg-muted">Data folder</dt>
                <dd className="break-all text-fg-secondary">{paths.userData}</dd>
              </>
            ) : null}
          </dl>
          {paths ? (
            <div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => invoke('app:revealPath', { path: paths.userData }).catch((e: unknown) => reportError("Couldn't open the folder", e))}
              >
                Open data folder
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </DialogContent>
  );
}

/** App-level informational dialogs opened from the titlebar and footer menus. */
export function InfoDialogs() {
  const dialog = useUi((s) => s.dialog);
  const setDialog = useUi((s) => s.setDialog);
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => (open ? undefined : setDialog(null))}>
      {dialog === 'shortcuts' ? <ShortcutsBody /> : null}
      {dialog === 'about' ? <AboutBody /> : null}
    </Dialog>
  );
}
