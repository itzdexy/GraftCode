import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider, requestText } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

let graft: LaunchedApp | undefined;
let provider: MockProvider | undefined;
test.afterEach(async () => { await graft?.close(); await provider?.close(); });

/** Suggestions as you type are on by default; here they never have one, so no grey text sits among the code. */
const SUGGESTION = 'The user sends a file with the cursor marked <CURSOR>';
const LIBRARY = 'export function twice(value: number): number { return value * 2; }\n';
const MAIN = 'import { twice } from "./library";\nexport const answer = twice(21);\n';

/** Messages from the page that say the Content-Security-Policy blocked something (an eval, a worker, a style). */
function cspReports(w: Page): string[] {
  const blocked: string[] = [];
  w.on('console', (message) => { if (/Content.Security.Policy|Refused to/i.test(message.text())) blocked.push(message.text()); });
  return blocked;
}

/**
 * The middle of a word on the editor's line that holds `line`; Monaco draws runs of same-coloured tokens as one element.
 * An edited line is drawn twice, plain and then coloured, and each drawing replaces its element: the word is measured
 * on the coloured line, found and measured in one step, once two readings agree. A mouse sent to an element that is
 * being replaced finds nothing there, or Monaco takes it for leaving the editor, and no hover starts.
 */
async function wordAt(w: Page, line: string, word: string): Promise<{ x: number; y: number }> {
  const measure = (): Promise<{ x: number; y: number } | null> => w.evaluate(([line, word]) => {
    const row = [...document.querySelectorAll('.monaco-editor .view-line')].find((element) => element.textContent?.includes(line));
    if (!row?.querySelector('span[class^="mtk"]:not(.mtk1)')) return null;
    const texts = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = texts.nextNode(); node; node = texts.nextNode()) {
      const at = node.textContent?.indexOf(word) ?? -1;
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at); range.setEnd(node, at + word.length);
      const box = range.getBoundingClientRect();
      return box.width ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
    }
    return null;
  }, [line, word] as const);
  let last = await measure();
  await expect.poll(async () => {
    const next = await measure();
    const steady = next !== null && JSON.stringify(next) === JSON.stringify(last);
    last = next;
    return steady;
  }, { message: `${word} drawn on the line with ${line}` }).toBe(true);
  return last!;
}

async function openInEditor(w: Page, provider: MockProvider, file: string): Promise<void> {
  provider.script({ text: 'Editor ready.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Open the project'); await composer.press('Enter');
  await expect(w.getByText('Editor ready.', { exact: true })).toBeVisible();
  await w.getByRole('button', { name: 'More actions' }).click();
  await w.getByRole('menuitem', { name: /^Files/ }).click();
  await w.getByRole('tree', { name: 'Files' }).getByRole('button', { name: new RegExp(`^${file}`) }).first().click();
  await w.getByRole('button', { name: 'Edit file', exact: true }).click();
  await expect(w.getByRole('textbox', { name: `Edit ${file}` })).toBeVisible();
}

test('editing keys, a hover with the type, F2 renaming across two files and Ctrl+click to the definition', async () => {
  const project = makeGitProject({ 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs' } }), 'library.ts': LIBRARY, 'main.ts': MAIN });
  const read = (file: string): string => fs.readFileSync(path.join(project, file), 'utf8');
  provider = await MockProvider.start(); graft = await launchGraft();
  const w = graft.window;
  const blocked = cspReports(w);
  provider.answer((body) => requestText(body).includes(SUGGESTION), { text: '' });
  await completeOnboarding(graft, provider, { project });
  await w.evaluate(async (folder) => {
    const bridge = (window as unknown as { graft: { invoke(channel: string, input?: unknown): Promise<{ ok: boolean; value: Array<{ id: string; path: string }> }> } }).graft;
    const selected = (await bridge.invoke('projects:list')).value.find((p) => p.path === folder);
    if (!selected || !(await bridge.invoke('projects:update', { id: selected.id, trusted: true })).ok) throw new Error('Could not trust the fixture project');
  }, project);
  await openInEditor(w, provider, 'main.ts');
  const editor = w.getByRole('textbox', { name: 'Edit main.ts' });
  const lines = w.locator('.monaco-editor .view-lines');
  const unsaved = w.getByLabel('Unsaved changes', { exact: true });
  // The TypeScript grammar colours the code once it has loaded, and with it the language's comment marks.
  await expect(lines.locator('span[class^="mtk"]:not(.mtk1)').first()).toBeVisible();

  // Ctrl+/ comments the line with the language's own marks, and again takes them out.
  await editor.focus(); await w.keyboard.press('Control+Home'); await w.keyboard.press('Control+/');
  await expect(lines).toContainText('// import { twice }');
  await w.keyboard.press('Control+/');
  await expect(lines).not.toContainText('//');
  await expect(unsaved).toHaveCount(0);
  // Alt+Down moves the line below the next one, Alt+Up back. A save is done once the panel shows it: the draft's
  // backup note above the code goes, and the code moves up with it.
  await w.keyboard.press('Alt+ArrowDown'); await w.keyboard.press('Control+S');
  await expect.poll(() => read('main.ts')).toBe('export const answer = twice(21);\nimport { twice } from "./library";\n');
  await expect(unsaved).toHaveCount(0);
  await w.keyboard.press('Alt+ArrowUp'); await w.keyboard.press('Control+S');
  await expect.poll(() => read('main.ts')).toBe(MAIN);
  await expect(unsaved).toHaveCount(0);

  // The mouse on a name shows its type from the language server.
  const twice = await wordAt(w, 'answer', 'twice');
  await w.mouse.move(twice.x, twice.y);
  // In view: widgets drawn outside the panel's frame were once placed off-screen.
  await expect(w.locator('.monaco-editor .monaco-hover').filter({ hasText: 'twice(value: number): number' })).toBeInViewport();
  await w.screenshot({ path: test.info().outputPath('editor-hover.png') });

  // Ctrl+click on a name opens the file that declares it, at the name.
  await w.keyboard.down('Control');
  await w.mouse.move(twice.x, twice.y + 1);
  await w.mouse.click(twice.x, twice.y);
  await w.keyboard.up('Control');
  const declaration = w.getByRole('textbox', { name: 'Edit library.ts' });
  await expect(declaration).toBeFocused();
  await expect(lines).toContainText('export function twice');

  // F2 offers the name for editing. The file that uses it is written; this one's draft changes and waits for a save.
  await w.keyboard.press('F2');
  const rename = w.getByRole('textbox', { name: /Rename input/ });
  await expect(rename).toHaveValue('twice');
  await expect(rename).toBeInViewport();
  await rename.fill('thrice'); await rename.press('Enter');
  await expect(w.getByRole('status').filter({ hasText: 'Renamed in 2 files.' })).toBeVisible();
  await expect.poll(() => read('main.ts')).toBe(MAIN.replaceAll('twice', 'thrice'));
  expect(read('library.ts')).toBe(LIBRARY);
  await expect(lines).toContainText('export function thrice');
  await expect(unsaved).toBeVisible();
  await declaration.focus(); await w.keyboard.press('Control+S');
  await expect.poll(() => read('library.ts')).toBe(LIBRARY.replace('twice', 'thrice'));
  // The note stays after the type check that follows the edit.
  await expect(w.getByRole('status').filter({ hasText: 'Type check complete' })).toBeVisible();
  await expect(w.getByRole('status').filter({ hasText: 'Renamed in 2 files.' })).toBeVisible();
  expect(blocked).toEqual([]);
});

test('a file open in the editor follows the disk, and unsaved edits get the choice', async () => {
  const project = makeGitProject({ 'notes.txt': 'first\n' });
  const notes = path.join(project, 'notes.txt');
  provider = await MockProvider.start(); graft = await launchGraft();
  const w = graft.window;
  const blocked = cspReports(w);
  provider.answer((body) => requestText(body).includes(SUGGESTION), { text: '' });
  await completeOnboarding(graft, provider, { project });
  await openInEditor(w, provider, 'notes.txt');
  const editor = w.getByRole('textbox', { name: 'Edit notes.txt' });
  const lines = w.locator('.monaco-editor .view-lines');
  const unsaved = w.getByLabel('Unsaved changes', { exact: true });
  await expect(lines).toContainText('first');

  // Without unsaved edits the change comes in place: the same editor, still holding the keyboard.
  await editor.focus(); await w.keyboard.press('Control+End');
  fs.writeFileSync(notes, 'first\nwritten by the agent\n');
  await expect(lines).toContainText('written by the agent');
  await expect(unsaved).toHaveCount(0);
  await expect(editor).toBeFocused();
  // Ctrl+Z steps back to what was shown before, as an unsaved edit.
  await w.keyboard.press('Control+Z');
  await expect(lines).not.toContainText('written by the agent');
  await expect(unsaved).toBeVisible();

  // With unsaved edits, a change on disk asks first.
  fs.writeFileSync(notes, 'first\nsecond version from disk\n');
  const bar = w.getByRole('region', { name: 'Changed on disk' });
  await expect(bar).toContainText('This file changed on disk while you were editing it.');
  await expect(lines).not.toContainText('second version');
  await bar.getByRole('button', { name: 'Compare' }).click();
  const compare = w.getByRole('dialog', { name: 'Compare with the file on disk' });
  await expect(compare.locator('.monaco-diff-editor')).toBeVisible();
  await expect(compare).toContainText('second version from disk');
  await w.screenshot({ path: test.info().outputPath('disk-compare.png') });
  await w.keyboard.press('Escape');
  await expect(compare).toHaveCount(0);
  await bar.getByRole('button', { name: 'Take theirs' }).click();
  await expect(bar).toHaveCount(0);
  await expect(lines).toContainText('second version from disk');
  await expect(unsaved).toHaveCount(0);
  await expect(editor).toBeFocused();

  // Keep mine, once confirmed, lets the next save replace the file on disk.
  await w.keyboard.press('Control+End'); await w.keyboard.type('my line');
  fs.writeFileSync(notes, 'third version from disk\n');
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Keep mine' }).click();
  await expect(bar).toContainText('Your next save will replace the file on disk with your version.');
  await expect(bar.getByRole('button', { name: 'Keep mine' })).toBeFocused();
  await bar.getByRole('button', { name: 'Keep mine' }).click();
  await expect(bar).toHaveCount(0);
  await expect(editor).toBeFocused();
  await w.keyboard.press('Control+S');
  await expect.poll(() => fs.readFileSync(notes, 'utf8')).toBe('first\nsecond version from disk\nmy line');
  await expect(unsaved).toHaveCount(0);
  // The editor's own save is not news to it.
  await w.waitForTimeout(1500);
  await expect(bar).toHaveCount(0);
  await expect(lines).toContainText('my line');
  expect(blocked).toEqual([]);
});
