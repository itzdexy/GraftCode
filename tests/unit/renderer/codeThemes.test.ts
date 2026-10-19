import { describe, expect, it } from 'vitest';
import { DARK_CODE_THEMES, DEFAULT_CODE_THEMES, LIGHT_CODE_THEMES } from '../../../src/shared/codeThemes';
import { AppSettingsSchema, DEFAULT_APP_SETTINGS } from '../../../src/shared/schemas/appSettings';
import { highlightLines, themePreview } from '../../../src/renderer/src/lib/highlight';

const SAMPLE = 'const greeting: string = "hi"; // say it';

/** The color a token was given for the dark theme and for the light one. */
const colors = (lines: Awaited<ReturnType<typeof highlightLines>>): string[] => (lines ?? []).flat().map((t) => `${t.style['--shiki-dark'] ?? ''}|${t.style['--shiki-light'] ?? ''}`);

describe('the colors code is shown in', () => {
  it('are a dark theme and a light one, Vitesse until changed, each from its own list', () => {
    expect(DEFAULT_APP_SETTINGS.appearance).toMatchObject({ codeThemeDark: DEFAULT_CODE_THEMES.dark, codeThemeLight: DEFAULT_CODE_THEMES.light });
    expect(DEFAULT_CODE_THEMES).toEqual({ dark: 'vitesse-dark', light: 'vitesse-light' });
    expect(AppSettingsSchema.shape.appearance.safeParse({ ...DEFAULT_APP_SETTINGS.appearance, codeThemeDark: 'vitesse-light' }).success).toBe(false);
    expect(new Set([...DARK_CODE_THEMES, ...LIGHT_CODE_THEMES].map((t) => t.id)).size).toBe(DARK_CODE_THEMES.length + LIGHT_CODE_THEMES.length);
  });

  it('change the tokens’ colors for each theme', async () => {
    const vitesse = await highlightLines(SAMPLE, 'ts');
    const chosen = await highlightLines(SAMPLE, 'ts', { dark: 'night-owl', light: 'catppuccin-latte' });
    expect(vitesse).not.toBeNull();
    expect(chosen).not.toBeNull();
    expect(chosen?.flat().map((t) => t.content).join('')).toBe(SAMPLE);
    expect(colors(chosen)).not.toEqual(colors(vitesse));
  });

  it('are previewed with each theme’s own background', async () => {
    const owl = await themePreview(SAMPLE, 'ts', 'night-owl');
    const latte = await themePreview(SAMPLE, 'ts', 'catppuccin-latte');
    expect(owl?.background.toLowerCase()).toBe('#011627');
    expect(latte?.background.toLowerCase()).toBe('#eff1f5');
    expect(owl?.lines.flat().map((t) => t.content).join('')).toBe(SAMPLE);
    expect(owl?.lines.flat().some((t) => t.italic)).toBe(true);
  });
});
