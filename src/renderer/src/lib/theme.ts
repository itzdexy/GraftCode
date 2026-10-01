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

/** Column widths behind Settings → Appearance → Transcript width (narrow is the measured default). */
const TRANSCRIPT_WIDTHS: Record<AppSettings['appearance']['transcriptWidth'], string> = { narrow: '700px', medium: '860px', wide: '1060px' };

/** Reduced motion, font sizes and the transcript width from Settings → Appearance. */
export function applyAppearance(appearance: AppSettings['appearance']): void {
  const root = document.documentElement;
  root.style.setProperty('--g-content-width', TRANSCRIPT_WIDTHS[appearance.transcriptWidth]);
  root.dataset.reducedMotion = appearance.reducedMotion ? 'true' : 'false';
  root.style.setProperty('--g-font-scale', String(appearance.uiFontSize / BASE_UI_FONT_SIZE));
  root.style.setProperty('--g-code-font-size', `${appearance.codeFontSize}px`);
}

export function applyPlatform(platform: string): void {
  document.documentElement.dataset.platform = platform;
}
