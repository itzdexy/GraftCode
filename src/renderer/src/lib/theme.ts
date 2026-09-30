import type { ResolvedTheme, ThemePreference } from '@shared/ipc/contracts';
import type { AppSettings } from '@shared/schemas/appSettings';
import { invoke } from './ipc';

const media = window.matchMedia('(prefers-color-scheme: dark)');

/** UI font size that corresponds to the measured type scale (--g-font-scale: 1). */
export const BASE_UI_FONT_SIZE = 13;

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return media.matches ? 'dark' : 'light';
  return preference;
}

/**
 * Applies a theme preference to the document and the native titlebar
 * overlay. For "system" it follows OS changes until the returned cleanup runs.
 */
export function applyTheme(preference: ThemePreference, onError: (error: unknown) => void): () => void {
  const apply = (): void => {
    const theme = resolveTheme(preference);
    document.documentElement.dataset.theme = theme;
    invoke('window:setTitlebarTheme', { theme }).catch(onError);
  };
  apply();
  if (preference !== 'system') return () => undefined;
  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}

/** Reduced motion and font sizes from Settings → Appearance. */
export function applyAppearance(appearance: AppSettings['appearance']): void {
  const root = document.documentElement;
  root.dataset.reducedMotion = appearance.reducedMotion ? 'true' : 'false';
  root.style.setProperty('--g-font-scale', String(appearance.uiFontSize / BASE_UI_FONT_SIZE));
  root.style.setProperty('--g-code-font-size', `${appearance.codeFontSize}px`);
}

export function applyPlatform(platform: string): void {
  document.documentElement.dataset.platform = platform;
}
