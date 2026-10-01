import { Button } from '../../components/Button';
import { invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { reportError, useToasts } from '../../stores/toasts';
import { Group, saveSettings, SettingRow, SwitchRow } from './common';

export function NotificationsSection() {
  const settings = useApp((s) => s.settings);
  if (!settings) return null;
  const n = settings.notifications;

  const test = (): void => {
    invoke('notifications:test')
      .then(({ shown }) => {
        if (!shown) useToasts.getState().push({ tone: 'error', title: 'Desktop notifications aren’t available', description: 'Your system doesn’t support them, or they are turned off for Graft.' });
      })
      .catch((e: unknown) => reportError("Couldn't show a notification", e));
  };

  return (
    <div className="flex flex-col gap-24">
      <Group title="Desktop notifications" description="Sent only when you aren't looking at the session, for example while Graft is in the background.">
        <SwitchRow label="Notifications" checked={n.enabled} onChange={(enabled) => saveSettings({ notifications: { enabled } })} />
        <SwitchRow label="When a session needs your input" description="A permission request or a question." checked={n.needsInput} disabled={!n.enabled} onChange={(needsInput) => saveSettings({ notifications: { needsInput } })} />
        <SwitchRow label="When a session finishes" checked={n.finished} disabled={!n.enabled} onChange={(finished) => saveSettings({ notifications: { finished } })} />
        <SwitchRow label="When a session stops with an error" checked={n.errors} disabled={!n.enabled} onChange={(errors) => saveSettings({ notifications: { errors } })} />
        <SettingRow
          label="Test"
          description="Shows a sample notification now."
          control={
            <Button size="sm" variant="secondary" onClick={test} disabled={!n.enabled}>
              Send test notification
            </Button>
          }
        />
      </Group>
      <Group title="Background">
        <SwitchRow
          label="Keep running in the tray"
          description="Closing the window hides Graft to the notification area; sessions keep working. Quit from the tray icon."
          checked={settings.behavior.runInTray}
          onChange={(runInTray) => saveSettings({ behavior: { runInTray } })}
        />
      </Group>
    </div>
  );
}
