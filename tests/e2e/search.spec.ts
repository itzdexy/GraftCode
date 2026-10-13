import { expect, test } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

let provider: MockProvider;
let graft: LaunchedApp;

test.beforeEach(async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  await completeOnboarding(graft, provider, {
    project: makeGitProject({
      'src/app.ts': 'export const total = 1;\n  // Total of the order\nconst subtotal = total - 1;\n',
      'src/lib/money.ts': 'export function total(items: number[]): number {\n  return items.length;\n}\n',
      'docs/notes.md': '# Notes\n\nThe total is shown last.\n',
      '.gitignore': 'build/\n',
      'build/out.js': 'var total = 1;\n'
    })
  });
  provider.script({ text: 'Ready.' });
  const composer = graft.window.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Hello');
  await composer.press('Enter');
  await expect(graft.window.getByText('Ready.', { exact: true })).toBeVisible();
});

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

test('text is found across the project, and a line opens its file at the match', async () => {
  const w = graft.window;

  // The key opens the Search tab with the keyboard in its box.
  await w.keyboard.press('Control+Shift+H');
  const panel = w.getByRole('region', { name: 'Changes' });
  await expect(panel.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
  const box = panel.getByRole('textbox', { name: 'Search in files' });
  await expect(box).toBeFocused();

  // Typing searches by itself. What git ignores (build/) is not listed.
  await box.fill('total');
  await expect(panel.getByText('5 lines in 3 files', { exact: true })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'src/app.ts' }).getByRole('button', { name: /^src\/app\.ts line \d+/ })).toHaveCount(3);
  await expect(panel.getByRole('region', { name: 'build/out.js' })).toHaveCount(0);
  // Both places on a line are marked.
  await expect(panel.getByRole('button', { name: 'src/app.ts line 3: const subtotal = total - 1;' }).locator('mark')).toHaveText(['total', 'total']);
  await w.screenshot({ path: test.info().outputPath('search-results.png') });

  // Matching case leaves the comment's "Total" out; naming files narrows further.
  await panel.getByRole('button', { name: 'Match case' }).click();
  await expect(panel.getByText('4 lines in 3 files', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Files to look in or leave out' }).click();
  await panel.getByRole('textbox', { name: 'Files to look in or leave out' }).fill('*.md');
  await expect(panel.getByText('1 line in 1 file', { exact: true })).toBeVisible();

  // The arrow keys walk from the box down the rows; Enter opens the line in the editor, at the match.
  await box.focus();
  await w.keyboard.press('ArrowDown');
  await expect(panel.getByRole('button', { name: /^notes\.md/ })).toBeFocused();
  await w.keyboard.press('ArrowDown');
  await expect(panel.getByRole('button', { name: 'docs/notes.md line 3: The total is shown last.' })).toBeFocused();
  await w.keyboard.press('Enter');
  await expect(panel.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
  await expect(w.getByRole('textbox', { name: 'Edit docs/notes.md' })).toBeFocused();
  await w.keyboard.type('grand ');
  await expect(w.locator('.monaco-editor .view-lines')).toContainText('The grand total is shown last.');

  // Back on the Search tab, the box and the list are as they were left.
  await panel.getByRole('tab', { name: 'Search' }).click();
  await expect(box).toHaveValue('total');
  await expect(panel.getByText('1 line in 1 file', { exact: true })).toBeVisible();

  // The results go to the message box as a file.
  await panel.getByRole('button', { name: 'Send the results to chat' }).click();
  await expect(w.getByText('The results added to your message')).toBeVisible();
  await expect(w.getByText('search-results.txt')).toBeVisible();
});

test('a pattern that cannot be read is said so, in the tab', async () => {
  const w = graft.window;
  await w.keyboard.press('Control+Shift+H');
  const panel = w.getByRole('region', { name: 'Changes' });
  await panel.getByRole('button', { name: 'Use a regular expression' }).click();
  await panel.getByRole('textbox', { name: 'Search in files' }).fill('(total');
  await expect(panel.getByRole('alert')).toContainText("That pattern can't be read: unclosed group.");
  // A pattern that reads is searched as one.
  await panel.getByRole('textbox', { name: 'Search in files' }).fill('items\\.\\w+');
  await expect(panel.getByText('1 line in 1 file', { exact: true })).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});
