import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = path.resolve('src/renderer/src/features/settings');

/** A Settings page's id, as in src/renderer/src/stores/nav.ts. The renderer's own test checks each one exists. */
type SettingsSection = string;

/** The files that draw each Settings page. Integrations, Hooks and Memory are drawn by Customize's editors, which have no rows of this kind. */
const PAGES: Record<string, SettingsSection> = {
  'ProfileSection.tsx': 'profile',
  'PersonalizationSection.tsx': 'personalization',
  'PrivacySection.tsx': 'privacy',
  'ProvidersSection.tsx': 'providers',
  'CatalogSection.tsx': 'providers',
  'ModelsSection.tsx': 'models',
  'AgentsSettings.tsx': 'models',
  'WebSearchSection.tsx': 'search',
  'MediaSection.tsx': 'media',
  'VoiceSection.tsx': 'voice',
  'PermissionsSection.tsx': 'permissions',
  'SandboxSection.tsx': 'sandbox',
  'AppearanceSection.tsx': 'appearance',
  'ShortcutsSection.tsx': 'shortcuts',
  'NotificationsSection.tsx': 'notifications',
  'UsageSection.tsx': 'usage',
  'DataSection.tsx': 'data',
  'AboutSection.tsx': 'about'
};

/** A row or a group whose name is written out in the page's source. */
const NAMED = /<(?:SettingRow|SwitchRow|SelectField|Group)\s+(?:label|title)="([^"]+)"/g;

describe('the index that Settings search reads', () => {
  it('lists every named row and group of every page (after adding a setting, run this file with -u)', async () => {
    const entries: Array<{ section: SettingsSection; label: string }> = [];
    for (const [file, section] of Object.entries(PAGES)) {
      const source = fs.readFileSync(path.join(DIR, file), 'utf8');
      for (const match of source.matchAll(NAMED)) {
        const label = match[1] ?? '';
        if (!entries.some((entry) => entry.section === section && entry.label === label)) entries.push({ section, label });
      }
    }
    expect(entries.length).toBeGreaterThan(60);
    await expect(`${JSON.stringify(entries, null, 2)}\n`).toMatchFileSnapshot(path.join(DIR, 'settingsIndex.json'));
  });

  it('knows every file that draws a page, so a new page cannot be left out of the search', () => {
    const drawn = fs.readdirSync(DIR).filter((name) => /Section\.tsx$/.test(name) || name === 'AgentsSettings.tsx');
    expect(drawn.filter((name) => !(name in PAGES))).toEqual([]);
    expect(Object.keys(PAGES).filter((name) => !drawn.includes(name))).toEqual([]);
  });
});
