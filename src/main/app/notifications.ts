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
 * Title and body of a session notification. Incognito chats show no title or
 * text: the system keeps notifications in its own history, outside Graft.
 */
export function notificationContent(summary: SessionSummary, kind: NotifyKind, text: string): { title: string; body: string } {
  if (summary.incognito) return { title: `${TITLES[kind]} · Incognito chat`, body: '' };
  return { title: `${TITLES[kind]} · ${summary.title}`, body: text.slice(0, 180) || summary.projectName || '' };
}

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
    ...notificationContent(options.summary, options.kind, options.text),
    silent: options.kind === 'finished'
  });
  notification.on('click', () => options.onClick(options.summary.id));
  notification.show();
}
