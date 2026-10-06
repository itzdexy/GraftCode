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
 * Whether a session notification is shown, and whether it is silent. What needs the user
 * may make a sound; a finished session never does, and with the sound switched off nothing does.
 */
export function notificationPlan(settings: AppSettings['notifications'], kind: NotifyKind): { show: boolean; silent: boolean } {
  const wanted = kind === 'needs-input' ? settings.needsInput : kind === 'finished' ? settings.finished : settings.errors;
  return { show: settings.enabled && wanted, silent: kind === 'finished' || !settings.sound };
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
  const plan = notificationPlan(options.settings.notifications, options.kind);
  if (options.visible || !plan.show || !Notification.isSupported()) return;
  const notification = new Notification({
    ...notificationContent(options.summary, options.kind, options.text),
    silent: plan.silent
  });
  notification.on('click', () => options.onClick(options.summary.id));
  notification.show();
}
