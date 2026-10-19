/**
 * The color themes code can be shown in: one for the dark theme and one for
 * the light, picked separately in Settings → Appearance. Each is a theme that
 * ships with shiki, named the way its authors name it.
 */

export const DARK_CODE_THEMES = [
  { id: 'vitesse-dark', label: 'Vitesse Dark' },
  { id: 'github-dark', label: 'GitHub Dark' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { id: 'night-owl', label: 'Night Owl' },
  { id: 'one-dark-pro', label: 'One Dark Pro' },
  { id: 'tokyo-night', label: 'Tokyo Night' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'rose-pine', label: 'Rosé Pine' },
  { id: 'everforest-dark', label: 'Everforest Dark' },
  { id: 'gruvbox-dark-medium', label: 'Gruvbox Dark' },
  { id: 'nord', label: 'Nord' },
  { id: 'monokai', label: 'Monokai' }
] as const;

export const LIGHT_CODE_THEMES = [
  { id: 'vitesse-light', label: 'Vitesse Light' },
  { id: 'github-light', label: 'GitHub Light' },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte' },
  { id: 'night-owl-light', label: 'Night Owl Light' },
  { id: 'one-light', label: 'One Light' },
  { id: 'rose-pine-dawn', label: 'Rosé Pine Dawn' },
  { id: 'everforest-light', label: 'Everforest Light' },
  { id: 'gruvbox-light-medium', label: 'Gruvbox Light' },
  { id: 'solarized-light', label: 'Solarized Light' },
  { id: 'min-light', label: 'Min Light' }
] as const;

export type DarkCodeTheme = (typeof DARK_CODE_THEMES)[number]['id'];
export type LightCodeTheme = (typeof LIGHT_CODE_THEMES)[number]['id'];
export type CodeTheme = DarkCodeTheme | LightCodeTheme;

export const DARK_CODE_THEME_IDS = DARK_CODE_THEMES.map((t) => t.id) as [DarkCodeTheme, ...DarkCodeTheme[]];
export const LIGHT_CODE_THEME_IDS = LIGHT_CODE_THEMES.map((t) => t.id) as [LightCodeTheme, ...LightCodeTheme[]];

/** The pair code is colored with: the dark theme's and the light theme's. */
export interface CodeThemePair {
  dark: DarkCodeTheme;
  light: LightCodeTheme;
}

export const DEFAULT_CODE_THEMES: CodeThemePair = { dark: 'vitesse-dark', light: 'vitesse-light' };
