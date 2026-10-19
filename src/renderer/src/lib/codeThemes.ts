import { useMemo } from 'react';
import { DEFAULT_CODE_THEMES, type CodeThemePair } from '@shared/codeThemes';
import { useApp } from '../stores/app';

/** The code themes Settings → Appearance chose: one for the dark theme, one for the light. */
export function useCodeThemes(): CodeThemePair {
  const dark = useApp((s) => s.settings?.appearance.codeThemeDark ?? DEFAULT_CODE_THEMES.dark);
  const light = useApp((s) => s.settings?.appearance.codeThemeLight ?? DEFAULT_CODE_THEMES.light);
  return useMemo(() => ({ dark, light }), [dark, light]);
}
