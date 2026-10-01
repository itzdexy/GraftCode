import type { WebContents } from 'electron';

/** Web contents owned by the Browser panel (they may navigate; the app window may not). */
const panelContents = new WeakSet<WebContents>();

export function registerBrowserPanel(contents: WebContents): void {
  panelContents.add(contents);
}

export function isBrowserPanel(contents: WebContents): boolean {
  return panelContents.has(contents);
}
