import { describe, expect, it } from 'vitest';
import { SETTINGS_GROUPS, SETTINGS_SECTIONS } from '../../../src/renderer/src/features/settings/sections';
import { searchSettings } from '../../../src/renderer/src/features/settings/settingsSearch';
import INDEX from '../../../src/renderer/src/features/settings/settingsIndex.json';

describe('the pages of Settings', () => {
  it('are the only ones the search index names, and each has a heading to be listed under', () => {
    const pages = new Set<string>(SETTINGS_SECTIONS.map((section) => section.id));
    expect(INDEX.filter((entry) => !pages.has(entry.section))).toEqual([]);
    const groups = new Set<string>(SETTINGS_GROUPS.map((group) => group.id));
    expect(SETTINGS_SECTIONS.filter((section) => !groups.has(section.group))).toEqual([]);
    // Pages of one heading stand together, in the order of the headings.
    const order = SETTINGS_SECTIONS.map((section) => SETTINGS_GROUPS.findIndex((group) => group.id === section.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('searching Settings', () => {
  const found = (query: string) => searchSettings(query).map((hit) => (hit.setting === null ? hit.page : `${hit.page} › ${hit.setting}`));

  it('finds a setting by the words beside it, and says which page it is on', () => {
    expect(found('motion')[0]).toBe('Appearance › Motion');
    expect(found('check edits')[0]).toBe('Models › Check edits for errors');
    // Any word of the label will do, and so will the start of one.
    expect(found('errors')).toContain('Models › Check edits for errors');
    expect(found('transc')).toContain('Appearance › Transcript view');
  });

  it('finds a page by its name or by what it is about, the page before its settings', () => {
    expect(found('appearance')[0]).toBe('Appearance');
    expect(found('shortcuts')[0]).toBe('Shortcuts');
    // "keys" is in the Providers page's description, not in its name.
    expect(found('keys')).toContain('Providers');
    // A page's name beside a setting's: the setting first, then the page whose description mentions it.
    expect(found('appearance theme')).toEqual(['Appearance › Theme', 'Appearance']);
    // The name of a page alone lists the page, then what is on it.
    expect(found('usage')).toEqual(['Usage', 'Usage › By day', 'Usage › By model']);
  });

  it('wants every word asked for, and returns nothing for nothing', () => {
    expect(found('motion zebra')).toEqual([]);
    expect(found('')).toEqual([]);
    expect(found('   ')).toEqual([]);
    expect(searchSettings('e', 5)).toHaveLength(5);
  });

  it('ranks a word that begins a name above one inside it or one only in the description', () => {
    const pages = [
      { id: 'appearance' as const, label: 'Appearance', description: 'Theme and text size.' },
      { id: 'data' as const, label: 'Data', description: 'Export the theme of your work.' }
    ];
    const index = [
      { section: 'appearance', label: 'Theme' },
      { section: 'appearance', label: 'Subtheme' },
      { section: 'gone', label: 'Theme of a page that no longer exists' }
    ];
    expect(searchSettings('theme', 8, pages, index)).toEqual([
      { section: 'appearance', page: 'Appearance', setting: 'Theme' },
      { section: 'appearance', page: 'Appearance', setting: 'Subtheme' },
      { section: 'appearance', page: 'Appearance', setting: null },
      { section: 'data', page: 'Data', setting: null }
    ]);
  });
});
