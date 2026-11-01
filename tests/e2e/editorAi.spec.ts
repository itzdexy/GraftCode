import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider, requestText } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

let graft: LaunchedApp | undefined;
let provider: MockProvider | undefined;
test.afterEach(async () => { await graft?.close(); await provider?.close(); });

/** The phrases that tell the editor's two requests apart from the agent's (main/editor/completions.ts). */
const SUGGESTION = 'The user sends a file with the cursor marked <CURSOR>';
const EDIT = 'the lines to change are between <selection> and </selection>';

test('suggestions as you type and Edit with AI change the draft, and the file only when it is saved', async () => {
  const original = 'first line\nsecond line\nthird line\n';
  const project = makeGitProject({ 'notes.txt': original });
  const notes = (): string => fs.readFileSync(path.join(project, 'notes.txt'), 'utf8');
  provider = await MockProvider.start(); graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
  const w = graft.window;
  // Only these places have a suggestion; every other pause in typing gets none.
  const suggestions: Record<string, string> = { 'The answer is<CURSOR>': ' 42.', 'Say<CURSOR>': ' hello world', 'Say <CURSOR>': 'hello world', 'Say hello<CURSOR>': ' world' };
  provider.answer((body) => requestText(body).includes(SUGGESTION), (body) => ({ text: Object.entries(suggestions).find(([place]) => requestText(body).includes(place))?.[1] ?? '' }));
  // One edit is still being written when it is stopped (the first rule that matches answers).
  provider.answer((body) => requestText(body).includes('Instruction: Take your time'), { text: 'NEVER SHOWN', hold: true }, { once: true });
  // The session's model rewrites the selected lines, and refines its own proposal when asked.
  provider.answer((body) => requestText(body).includes(EDIT), (body) => ({ text: requestText(body).includes('<proposal>') ? 'FIRST\nSECOND' : 'FIRST LINE\nSECOND LINE' }));
  provider.script({ text: 'Editor ready.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Open the project'); await composer.press('Enter');
  await expect(w.getByText('Editor ready.', { exact: true })).toBeVisible();
  await w.getByRole('button', { name: 'More actions' }).click();
  await w.getByRole('menuitem', { name: /^Files/ }).click();
  await w.getByRole('tree', { name: 'Files' }).getByRole('button', { name: /^notes.txt/ }).first().click();
  await w.getByRole('button', { name: 'Edit file', exact: true }).click();
  const editor = w.getByRole('textbox', { name: 'Edit notes.txt' });
  await expect(editor).toBeVisible();
  const toggle = w.getByRole('button', { name: 'Suggestions as you type' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const lines = w.locator('.monaco-editor .view-lines');

  // A grey suggestion from the fast model appears once typing pauses, and Tab takes it into the draft.
  await editor.focus(); await w.keyboard.press('Control+End'); await w.keyboard.type('The answer is');
  const ghost = w.locator('.monaco-editor .ghost-text-decoration');
  await expect(ghost).toContainText('42.');
  const suggestion = provider.requests.find((r) => requestText(r.body).includes('The answer is<CURSOR>'));
  expect((suggestion?.body as { model?: string }).model).toBe('graft-test-mini');
  await w.keyboard.press('Tab');
  await expect(ghost).toHaveCount(0);
  await expect(lines).toContainText('The answer is 42.');
  // Ctrl+Right takes a suggestion a word at a time (the space before a word first), and Escape dismisses the rest.
  await w.keyboard.press('Enter'); await w.keyboard.type('Say');
  await expect(ghost).toContainText('hello world');
  await w.keyboard.press('Control+ArrowRight'); await w.keyboard.press('Control+ArrowRight');
  await expect(ghost).not.toContainText('hello');
  await expect(ghost).toContainText('world');
  await w.keyboard.press('Escape');
  await expect(ghost).toHaveCount(0);
  // The view shows grey text among the code, so the draft is read once none is left.
  await expect(lines).toContainText('Say hello');
  await expect(lines).not.toContainText('world');
  // With no suggestion on screen, Tab indents as always.
  await w.keyboard.press('Enter'); await w.keyboard.press('Tab'); await w.keyboard.type('done');
  expect(notes()).toBe(original);
  await w.keyboard.press('Control+S');
  const typed = 'The answer is 42.\nSay hello\n  done';
  await expect.poll(notes).toBe(`${original}${typed}`);

  // Edit with AI on two selected lines: the proposal shows as a diff before anything changes.
  await w.keyboard.press('Control+Home'); await w.keyboard.press('Shift+ArrowDown'); await w.keyboard.press('Shift+ArrowDown');
  await w.keyboard.press('Control+I');
  const box = w.getByRole('group', { name: 'Edit with AI' });
  await expect(box.getByRole('textbox', { name: 'Describe the change' })).toBeFocused();
  await w.keyboard.type('Shout it'); await w.keyboard.press('Enter');
  await expect(box.getByRole('status')).toContainText('2 lines become 2 lines');
  const added = w.locator('.monaco-editor .graft-ai-added');
  await expect(added).toContainText('FIRST LINE');
  await expect(w.locator('.monaco-editor .graft-ai-removed-text').first()).toBeVisible();
  await expect(lines).toContainText('first line');
  await w.screenshot({ path: test.info().outputPath('inline-edit-proposal.png') });
  // The box stays open: a follow-up refines the proposal on screen.
  await expect(box.getByRole('textbox', { name: 'Change the proposal' })).toBeFocused();
  await w.keyboard.type('Only the first word'); await w.keyboard.press('Enter');
  await expect(added).not.toContainText('LINE');
  await expect(added).toContainText('FIRST');
  const refine = provider.requests.filter((r) => requestText(r.body).includes(EDIT));
  expect(refine.map((r) => (r.body as { model?: string }).model)).toEqual(['graft-test-large', 'graft-test-large']);
  expect(requestText(refine[1]?.body)).toContain('<proposal>\nFIRST LINE\nSECOND LINE\n</proposal>');
  await w.keyboard.press('Control+Enter');
  await expect(box).toHaveCount(0);
  await expect(added).toHaveCount(0);
  await expect(lines).toContainText('FIRST');
  await expect(lines).not.toContainText('first line');
  // The draft changed; the file waits for a save.
  await expect(w.getByLabel('Unsaved changes', { exact: true })).toBeVisible();
  expect(notes()).toBe(`${original}${typed}`);
  // One Ctrl+Z takes the whole edit back.
  await w.keyboard.press('Control+Z');
  await expect(lines).toContainText('first line');
  await expect(lines).toContainText('second line');
  await w.keyboard.press('Control+Y');
  await expect(lines).not.toContainText('first line');
  await w.keyboard.press('Control+S');
  const edited = `FIRST\nSECOND\nthird line\n${typed}`;
  await expect.poll(notes).toBe(edited);

  // The toolbar's button opens the same box. Stop ends the request in the main process; Escape closes the box and nothing changes.
  await w.getByRole('button', { name: 'Edit with AI' }).click();
  await expect(box.getByRole('textbox', { name: 'Describe the change' })).toBeFocused();
  await w.keyboard.type('Take your time'); await w.keyboard.press('Enter');
  await expect(box.getByRole('status')).toHaveText('Writing the change…');
  const ended = provider.waitForHeldStreamClosed();
  await box.getByRole('button', { name: 'Stop' }).click();
  await ended;
  await expect(box.getByRole('status')).toHaveText('Stopped. Enter asks again.');
  await expect(box.getByRole('textbox', { name: 'Describe the change' })).toBeFocused();
  await expect(added).toHaveCount(0);
  await w.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
  await expect(editor).toBeFocused();

  // Switched off in the toolbar, typing asks nothing.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const asked = provider.requests.filter((r) => requestText(r.body).includes(SUGGESTION)).length;
  await editor.focus(); await w.keyboard.press('Control+End'); await w.keyboard.type(' More');
  await w.waitForTimeout(1_000);
  expect(provider.requests.filter((r) => requestText(r.body).includes(SUGGESTION))).toHaveLength(asked);
  expect(notes()).toBe(edited);
});

test('Settings choose the model suggestions come from, and the toolbar names it', async () => {
  const project = makeGitProject({ 'notes.txt': 'hello\n' });
  provider = await MockProvider.start(); graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
  const w = graft.window;
  provider.answer((body) => requestText(body).includes(SUGGESTION), { text: '' });
  provider.script({ text: 'Settings ready.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Open the project'); await composer.press('Enter');
  await expect(w.getByText('Settings ready.', { exact: true })).toBeVisible();

  // Settings → Models → Editor: on by default, from the provider's fast model until another is chosen.
  const openSettings = async (): Promise<Locator> => {
    await w.getByRole('button', { name: /^Account menu for/ }).click();
    await w.getByRole('menuitem', { name: 'Settings' }).click();
    const settings = w.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Models', exact: true }).click();
    return settings;
  };
  let settings = await openSettings();
  const group = settings.getByRole('region', { name: 'Editor' });
  await expect(group.getByRole('switch', { name: 'Suggestions as you type' })).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByLabel('Model for suggestions')).toHaveValue('');
  await group.getByLabel('Model for suggestions').selectOption({ label: 'Graft Test Large' });
  await expect(group.getByText(/code around the cursor/)).toBeVisible();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();

  await w.getByRole('button', { name: 'More actions' }).click();
  await w.getByRole('menuitem', { name: /^Files/ }).click();
  await w.getByRole('tree', { name: 'Files' }).getByRole('button', { name: /^notes.txt/ }).first().click();
  await w.getByRole('button', { name: 'Edit file', exact: true }).click();
  const toggle = w.getByRole('button', { name: 'Suggestions as you type' });
  await toggle.hover();
  await expect(w.getByRole('tooltip')).toContainText('Suggestions as you type, from Graft Test Large');
  const editor = w.getByRole('textbox', { name: 'Edit notes.txt' });
  await editor.focus(); await w.keyboard.press('Control+End'); await w.keyboard.type('Next');
  const chosen = (): boolean => provider?.requests.some((r) => requestText(r.body).includes('Next<CURSOR>') && (r.body as { model?: string }).model === 'graft-test-large') ?? false;
  await expect.poll(chosen).toBe(true);

  // Switched off in Settings, the toolbar shows it off too.
  settings = await openSettings();
  await settings.getByRole('region', { name: 'Editor' }).getByRole('switch', { name: 'Suggestions as you type' }).click();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});
