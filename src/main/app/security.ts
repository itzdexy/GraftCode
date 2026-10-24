import { app, session, shell, type Session, type WebContents } from 'electron';
import { isBrowserPanel } from '../browser/registry';
import { log } from './log';

/** Only http(s) URLs may be opened in the user's browser. */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export async function openExternalSafely(raw: string): Promise<void> {
  if (!isSafeExternalUrl(raw)) {
    log.warn('security', 'Blocked external URL', { scheme: raw.split(':')[0] ?? '' });
    return;
  }
  await shell.openExternal(raw);
}

/**
 * Refuses every permission a page asks for or checks. Electron grants them all to a session
 * that has no handler: camera, microphone, location, the clipboard. This is the rule for a
 * session that shows pages Graft did not write.
 */
export function denyAllPermissions(target: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>): void {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}

export interface PermissionPolicy {
  /** Microphone access for dictation; granted only while a transcription provider is configured. */
  allowMicrophone: () => boolean;
}

function applyPermissionPolicy(target: Session, policy: PermissionPolicy): void {
  target.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission === 'clipboard-sanitized-write') return callback(true);
    if (permission === 'media') {
      const wantsVideo = 'mediaTypes' in details && Array.isArray(details.mediaTypes) && details.mediaTypes.includes('video');
      return callback(!wantsVideo && policy.allowMicrophone());
    }
    log.info('security', 'Denied permission request', { permission });
    callback(false);
  });
  target.setPermissionCheckHandler((_contents, permission) => {
    if (permission === 'clipboard-sanitized-write') return true;
    if (permission === 'media') return policy.allowMicrophone();
    return false;
  });
}

/**
 * App-wide hardening: no navigation away from the app, no new windows (links
 * open in the default browser), no <webview>, and deny-by-default permissions
 * in the app's own session and in every session created later.
 */
export function installSecurityPolicy(policy: PermissionPolicy): void {
  applyPermissionPolicy(session.defaultSession, policy);
  // Every session made from here on starts out refusing everything, whichever part of Graft makes
  // it and whether or not that part remembers to. The ones with rules of their own (the Browser
  // panel) set them after the session exists, which replaces this.
  app.on('session-created', (created) => denyAllPermissions(created));

  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      void openExternalSafely(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      // The Browser panel applies its own http(s)-only rule (browser/browserPanel.ts).
      if (isBrowserPanel(contents)) return;
      if (url !== contents.getURL()) {
        event.preventDefault();
        log.warn('security', 'Blocked in-app navigation', { scheme: url.split(':')[0] ?? '' });
      }
    });
  });
}
