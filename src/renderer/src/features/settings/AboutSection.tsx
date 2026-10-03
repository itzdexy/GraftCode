import { useState } from 'react';
import type { UpdateState } from '@shared/schemas/system';
import { Button } from '../../components/Button';
import { Switch } from '../../components/Field';
import { ErrorState, LoadingState } from '../../components/States';
import { Mark } from '../../brand/Mark';
import { Wordmark } from '../../brand/Wordmark';
import { relativeTime } from '../../lib/format';
import { invoke } from '../../lib/ipc';
import { useNow } from '../../lib/time';
import { useLoad } from '../../lib/useLoad';
import { useApp } from '../../stores/app';
import { reportError } from '../../stores/toasts';
import { ConfirmDialog, Group, saveSettings, SettingRow } from './common';

export function updateStatusText(update: UpdateState | null, now: number): string {
  if (!update) return 'Checking update status…';
  switch (update.status) {
    case 'off':
      return 'Automatic updates are off.';
    case 'unsupported':
      return update.message ?? 'Updates aren’t available for this build.';
    case 'idle':
      return 'Graft checks for updates in the background.';
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Version ${update.version ?? 'new'} is available.`;
    case 'downloading':
      return `Downloading version ${update.version ?? 'new'}${update.progress !== null ? ` (${Math.round(update.progress)}%)` : ''}…`;
    case 'ready':
      return `Version ${update.version ?? 'new'} is ready. Restart Graft to install it.`;
    case 'none':
      return `You’re up to date${update.checkedAt ? ` (checked ${relativeTime(update.checkedAt, now)})` : ''}.`;
    case 'error':
      return `The last check failed: ${update.message ?? 'unknown error'}.`;
  }
}

export function AboutSection() {
  const enabled = useApp((s) => s.settings?.updates.enabled ?? false);
  const update = useApp((s) => s.update);
  const now = useNow(60_000);
  const { load: info, reload } = useLoad(() => invoke('app:info'), 'about');
  const [restart, setRestart] = useState(false);
  const busy = update?.status === 'checking' || update?.status === 'downloading';

  return (
    <div className="flex flex-col gap-24">
      <div className="flex items-center gap-12">
        <Mark size={36} motion="idle" interactive />
        <div>
          <Wordmark className="text-xl" />
          <p className="mt-4 text-sm text-fg-muted">A desktop coding agent that works with your own model provider keys.</p>
        </div>
      </div>

      <Group title="Updates">
        <SettingRow
          label="Check for updates automatically"
          description={updateStatusText(update, now)}
          control={<Switch label="Check for updates automatically" checked={enabled} onChange={(on) => saveSettings({ updates: { enabled: on } })} />}
        />
        {enabled && update && update.status !== 'unsupported' ? (
          <SettingRow
            label="Check now"
            control={
              update.status === 'ready' ? (
                <Button size="sm" variant="primary" onClick={() => setRestart(true)}>
                  Restart to update
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    invoke('updates:check')
                      .then((state) => useApp.getState().setUpdate(state))
                      .catch((e: unknown) => reportError("Couldn't check for updates", e));
                  }}
                >
                  {busy ? 'Checking…' : 'Check for updates'}
                </Button>
              )
            }
          />
        ) : null}
        {update?.status === 'error' && info.status === 'ready' && info.data.releasesUrl ? (
          <SettingRow
            label="Download it yourself"
            description="If updating keeps failing, get the newest installer from the releases page and run it. Your chats and settings stay."
            control={
              <Button size="sm" variant="secondary" onClick={() => void invoke('app:openExternal', { url: info.data.releasesUrl ?? '' }).catch((e: unknown) => reportError("Couldn't open the releases page", e))}>
                Open releases
              </Button>
            }
          />
        ) : null}
      </Group>

      <Group title="Version">
        {info.status === 'loading' ? <LoadingState className="py-12" /> : null}
        {info.status === 'error' ? <ErrorState title="Couldn't read version information" message={info.message} onRetry={reload} className="py-12" /> : null}
        {info.status === 'ready' ? (
          <dl className="selectable grid grid-cols-[140px_minmax(0,1fr)] gap-x-12 gap-y-6 px-14 py-12 text-base">
            <dt className="text-fg-muted">Graft</dt>
            <dd className="text-fg">
              {info.data.version}
              {info.data.isPackaged ? '' : ' (development)'}
            </dd>
            <dt className="text-fg-muted">Electron</dt>
            <dd className="text-fg">{info.data.versions.electron}</dd>
            <dt className="text-fg-muted">Chromium</dt>
            <dd className="text-fg">{info.data.versions.chrome}</dd>
            <dt className="text-fg-muted">Node.js</dt>
            <dd className="text-fg">{info.data.versions.node}</dd>
            <dt className="text-fg-muted">Data folder</dt>
            <dd className="truncate text-fg" title={info.data.dataDir}>
              {info.data.dataDir}
            </dd>
          </dl>
        ) : null}
      </Group>

      <ConfirmDialog
        open={restart}
        onOpenChange={setRestart}
        title="Restart to update?"
        description="Graft closes, installs the update and opens again. Running sessions stop; their history is kept."
        confirmLabel="Restart now"
        onConfirm={async () => {
          await invoke('updates:install');
        }}
      />
    </div>
  );
}
