import type { ResolvedTheme, ThemePreference } from '@shared/ipc/contracts';
import { invoke } from './ipc';

const media = window.matchMedia('(prefers-color-scheme: dark)');

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

export function applyReducedMotion(enabled: boolean): void {
  document.documentElement.dataset.reducedMotion = enabled ? 'true' : 'false';
}
