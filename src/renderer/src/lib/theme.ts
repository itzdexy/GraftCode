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

const HEX = /^#[0-9a-f]{6}$/i;

/** Gives the native titlebar overlay the current palette's background and icon colours. */
function syncTitlebar(onError: (error: unknown) => void): void {
  const root = document.documentElement;
  const theme = root.dataset.theme === 'light' ? 'light' : 'dark';
  const style = getComputedStyle(root);
  const background = style.getPropertyValue('--g-bg').trim();
  const symbol = style.getPropertyValue('--g-icon').trim();
  const colors = HEX.test(background) && HEX.test(symbol) ? { background, symbol } : undefined;
  invoke('window:setTitlebarTheme', { theme, ...(colors ? { colors } : {}) }).catch(onError);
}

/**
 * Applies a theme preference to the document and the native titlebar
 * overlay. For "system" it follows OS changes until the returned cleanup runs.
 */
export function applyTheme(preference: ThemePreference, onError: (error: unknown) => void): () => void {
  const apply = (): void => {
    document.documentElement.dataset.theme = resolveTheme(preference);
    syncTitlebar(onError);
  };
  apply();
  if (preference !== 'system') return () => undefined;
  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}

/** Column widths behind Settings → Appearance → Transcript width (narrow is the measured default). */
const TRANSCRIPT_WIDTHS: Record<AppSettings['appearance']['transcriptWidth'], string> = { narrow: '700px', medium: '860px', wide: '1060px' };

/** Palette, accent, reduced motion, font sizes and the transcript width from Settings → Appearance. */
export function applyAppearance(appearance: AppSettings['appearance'], onError: (error: unknown) => void): void {
  const root = document.documentElement;
  const repaint = root.dataset.palette !== appearance.palette;
  root.dataset.palette = appearance.palette;
  root.dataset.accent = appearance.accent;
  if (repaint) syncTitlebar(onError);
  root.style.setProperty('--g-content-width', TRANSCRIPT_WIDTHS[appearance.transcriptWidth]);
  root.dataset.reducedMotion = appearance.reducedMotion ? 'true' : 'false';
  root.style.setProperty('--g-font-scale', String(appearance.uiFontSize / BASE_UI_FONT_SIZE));
  root.style.setProperty('--g-code-font-size', `${appearance.codeFontSize}px`);
}

export function applyPlatform(platform: string): void {
  document.documentElement.dataset.platform = platform;
}
