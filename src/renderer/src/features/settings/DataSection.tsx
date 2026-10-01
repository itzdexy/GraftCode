import { useState } from 'react';
import { Button } from '../../components/Button';
import { Switch } from '../../components/Field';
import { invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { useApp } from '../../stores/app';
import { useNav } from '../../stores/nav';
import { reportError, useToasts } from '../../stores/toasts';
import { ConfirmDialog, Group, saveSettings, SettingRow } from './common';

export function DataSection() {
  const settings = useApp((s) => s.settings);
  const paths = useApp((s) => s.paths);
  const [confirm, setConfirm] = useState<'clear' | 'onboarding' | null>(null);
  const [exporting, setExporting] = useState(false);
  const { load: secrets } = useLoad(() => invoke('secrets:status'), String(settings?.security.allowPlaintextKeys));
  if (!settings) return null;

  const exportAll = async (): Promise<void> => {
    setExporting(true);
    try {
      const result = await invoke('data:export');
      if (result) {
        useToasts.getState().push({
          tone: 'success',
          title: `Exported ${result.sessions} ${result.sessions === 1 ? 'session' : 'sessions'}`,
          description: result.path,
          action: { label: 'Show in folder', run: () => void invoke('app:revealPath', { path: result.path }).catch((e: unknown) => reportError("Couldn't open the folder", e)) }
        });
      }
    } catch (e) {
      reportError("Couldn't export your data", e);
    } finally {
      setExporting(false);
    }
  };

  const keyring = secrets.status === 'ready' ? secrets.data.encryptionAvailable : null;

  return (
    <div className="flex flex-col gap-24">
      <Group title="Your data" description={paths ? <span className="selectable">Stored in {paths.userData}</span> : undefined}>
        <SettingRow
          label="Export everything"
          description="Settings, projects, schedules and every saved session with its messages, as one JSON file. API keys are never included."
          control={
            <Button size="sm" variant="secondary" disabled={exporting} onClick={() => void exportAll()}>
              {exporting ? 'Exporting…' : 'Export…'}
            </Button>
          }
        />
        <SettingRow
          label="Data folder"
          description="The database, logs and window layout."
          control={
            <Button size="sm" variant="secondary" onClick={() => void invoke('data:openFolder').catch((e: unknown) => reportError("Couldn't open the data folder", e))}>
              Open folder
            </Button>
          }
        />
      </Group>

      <Group title="API keys">
        <SettingRow
          label="Key storage"
          description={
            keyring === null
              ? 'Checking…'
              : keyring
                ? 'Keys are encrypted with your operating system’s secure storage.'
                : 'This system has no secure key storage, so keys can only be saved unencrypted.'
          }
        />
        {keyring === false ? (
          <SettingRow
            label="Store keys unencrypted"
            description="Keys are saved as plain text in the data folder. Turning this off deletes keys stored that way."
            control={
              <Switch label="Store keys unencrypted" checked={settings.security.allowPlaintextKeys} onChange={(allowPlaintextKeys) => saveSettings({ security: { allowPlaintextKeys } })} />
            }
          />
        ) : null}
      </Group>

      <Group title="Reset">
        <SettingRow
          label="Clear session history"
          description="Deletes every saved chat and session. Worktree folders stay on disk so no uncommitted work is lost."
          control={
            <Button size="sm" variant="secondary" onClick={() => setConfirm('clear')}>
              Clear history…
            </Button>
          }
        />
        <SettingRow
          label="Run setup again"
          description="Walks through name, picture, provider and defaults again. Your providers and sessions stay."
          control={
            <Button size="sm" variant="secondary" onClick={() => setConfirm('onboarding')}>
              Run setup…
            </Button>
          }
        />
      </Group>

      <ConfirmDialog
        open={confirm === 'clear'}
        onOpenChange={(open) => setConfirm(open ? 'clear' : null)}
        title="Clear all session history?"
        description="Every saved chat and code session is deleted, including running ones, and can't be recovered. Export first if you want a copy."
        confirmLabel="Delete all sessions"
        danger
        onConfirm={async () => {
          const result = await invoke('data:clearHistory');
          useNav.getState().go({ name: 'settings', section: 'data' });
          useToasts.getState().push({
            tone: 'success',
            title: `Deleted ${result.removed} ${result.removed === 1 ? 'session' : 'sessions'}`,
            ...(result.worktreesKept > 0 ? { description: `${result.worktreesKept} worktree ${result.worktreesKept === 1 ? 'folder was' : 'folders were'} left on disk.` } : {})
          });
        }}
      />
      <ConfirmDialog
        open={confirm === 'onboarding'}
        onOpenChange={(open) => setConfirm(open ? 'onboarding' : null)}
        title="Run setup again?"
        description="Graft shows the welcome steps now. Nothing is deleted."
        confirmLabel="Run setup"
        onConfirm={async () => {
          const next = await invoke('onboarding:reset');
          useApp.getState().restartOnboarding(next);
        }}
      />
    </div>
  );
}
