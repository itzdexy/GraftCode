import { Notification } from 'electron';
import type { SessionSummary } from '@shared/schemas/sessions';
import type { AppSettings } from '@shared/schemas/appSettings';

export type NotifyKind = 'needs-input' | 'finished' | 'error';

const TITLES: Record<NotifyKind, string> = {
  'needs-input': 'Needs your input',
  finished: 'Finished',
  error: 'Stopped with an error'
};

/**
 * Desktop notifications for sessions the user isn't looking at. Clicking a
 * notification brings the window forward on that session.
 */
export function showSessionNotification(options: {
  settings: AppSettings;
  summary: SessionSummary;
  kind: NotifyKind;
  text: string;
  visible: boolean;
  onClick: (sessionId: string) => void;
}): void {
  const n = options.settings.notifications;
  if (options.visible || !n.enabled || !Notification.isSupported()) return;
  if ((options.kind === 'needs-input' && !n.needsInput) || (options.kind === 'finished' && !n.finished) || (options.kind === 'error' && !n.errors)) return;
  const notification = new Notification({
    title: `${TITLES[options.kind]} · ${options.summary.title}`,
    body: options.text.slice(0, 180) || options.summary.projectName || '',
    silent: options.kind === 'finished'
  });
  notification.on('click', () => options.onClick(options.summary.id));
  notification.show();
}
