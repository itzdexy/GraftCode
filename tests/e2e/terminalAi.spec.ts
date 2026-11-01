import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider, requestText } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');

async function shot(w: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await w.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

let provider: MockProvider;
let graft: LaunchedApp;
let shell: { kind: string; label: string };

test.beforeEach(async () => {
  provider = await MockProvider.start();
  const project = makeGitProject({ 'notes.txt': 'hello\n' });
  graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
  provider.script({ text: 'Ready.' });
  const composer = graft.window.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Get ready');
  await composer.press('Enter');
  await expect(graft.window.getByText('Ready.', { exact: true })).toBeVisible();
  shell = await graft.window.evaluate(async () => {
    const bridge = (window as unknown as { graft: { invoke(c: string): Promise<{ value: { shell: { kind: string; label: string } } }> } }).graft;
    return (await bridge.invoke('app:environment')).value.shell;
  });
});

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

/** Opens the Terminal panel and waits for the shell's first prompt, with the keyboard in the terminal. */
async function openTerminal(w: Page) {
  await w.getByRole('button', { name: 'Terminal', exact: true }).click();
  const panel = w.getByRole('region', { name: 'Terminal' });
  const screen = panel.locator('.xterm-rows');
  await expect(screen).toContainText(shell.kind === 'powershell' ? 'PS ' : '$');
  await panel.locator('.xterm').click();
  return { panel, screen };
}

/** The terminal's words for "print 42 with this prefix", in the test machine's shell (Git Bash or PowerShell on Windows, bash on Linux). */
const printing = (prefix: string): string => (shell.kind === 'powershell' ? `Write-Output "${prefix}-$(40+2)"` : `echo ${prefix}-$((40+2))`);

test('Ctrl+K in the terminal writes a command from words and types it at the prompt without running it', async () => {
  const w = graft.window;
  provider.answer((body) => requestText(body).includes('Request: print the answer'), () => ({ text: `\`\`\`\n${printing('words')}\n\`\`\`` }), { once: true });
  const { panel, screen } = await openTerminal(w);

  // The terminal keeps Ctrl+K: the bar opens over it, and the app's search does not.
  await w.keyboard.press('Control+k');
  const bar = panel.getByRole('group', { name: 'Write a command' });
  const box = bar.getByRole('textbox', { name: 'Describe a command' });
  await expect(box).toBeFocused();
  await expect(w.getByRole('dialog', { name: 'Search sessions' })).toHaveCount(0);
  await box.fill('print the answer');
  await shot(w, 'terminal-ai-bar');
  await box.press('Enter');

  // Typed at the prompt, not run: the output appears only after Enter, which reaches the terminal.
  await expect(screen).toContainText(printing('words'));
  await expect(bar).toBeHidden();
  await expect(screen).not.toContainText('words-42');
  const asked = provider.requests.map((request) => requestText(request.body)).find((text) => text.includes('Request: print the answer')) ?? '';
  expect(asked).toContain(`Shell: ${shell.label} (${shell.kind})`);
  expect(asked).toMatch(/Folder: \S/);
  await w.keyboard.press('Enter');
  await expect(screen).toContainText('words-42');

  // While the model writes, Stop ends the request and nothing is typed.
  provider.answer((body) => requestText(body).includes('Request: take your time'), { text: 'sleep 999', hold: true }, { once: true });
  await w.keyboard.press('Control+k');
  await box.fill('take your time');
  const stopped = provider.waitForHeldStreamClosed();
  await box.press('Enter');
  await expect(bar.getByRole('status')).toHaveText('Writing the command…');
  await bar.getByRole('button', { name: 'Stop' }).click();
  await stopped;
  await expect(bar.getByRole('button', { name: 'Stop' })).toBeHidden();
  await expect(box).toBeFocused();
  await expect(bar.getByRole('alert')).toHaveCount(0);
  await expect(screen).not.toContainText('sleep 999');

  // A model that answers with two lines types nothing, and says so in the bar; Escape closes it.
  provider.answer((body) => requestText(body).includes('Request: two things'), { text: 'cd src\nls' }, { once: true });
  await box.fill('two things');
  await box.press('Enter');
  await expect(bar.getByRole('alert')).toHaveText(/more than one line/);
  await box.press('Escape');
  await expect(bar).toBeHidden();
  await expect(panel.locator('.xterm-helper-textarea')).toBeFocused();
});

test('a failed command gets a mark and its actions: Explain beside the session, Fix typed at the prompt, Add to message', async () => {
  const w = graft.window;
  const { panel, screen } = await openTerminal(w);
  const fail = shell.kind === 'powershell' ? 'cmd /c exit 3' : '(exit 3)';
  await w.keyboard.type(fail);
  await w.keyboard.press('Enter');

  const chip = panel.getByRole('group', { name: `${fail} failed with exit code 3` });
  await expect(chip).toBeVisible();
  await expect(panel.locator('.xterm-decoration.bg-danger')).toHaveCount(1);
  await shot(w, 'terminal-ai-failed');

  // Ctrl+. brings the keyboard from the terminal to the actions.
  await panel.locator('.xterm').click();
  await w.keyboard.press('Control+.');
  await expect(chip.getByRole('button', { name: 'Explain' })).toBeFocused();

  // Explain asks a side question: the answer shows beside the conversation and is not part of it.
  provider.answer((body) => requestText(body).includes('The side question: Why did'), { text: 'It exited with code 3 on purpose.' }, { once: true });
  await chip.getByRole('button', { name: 'Explain' }).click();
  const asides = w.getByRole('list', { name: 'Side questions' });
  await expect(asides).toContainText('It exited with code 3 on purpose.');
  await expect(asides).toContainText(`Why did \`${fail}\` fail (exit code 3)`);
  await expect(w.getByRole('log', { name: 'Conversation' })).not.toContainText('on purpose');

  // Add to message attaches the command and its output to the message box.
  await chip.getByRole('button', { name: 'Add to message' }).click();
  await expect(w.getByRole('button', { name: 'Remove terminal-command.txt' })).toBeVisible();

  // Fix asks for one corrected command and types it; nothing runs until Enter.
  provider.answer((body) => requestText(body).includes('failed with exit code 3'), () => ({ text: printing('fixed') }), { once: true });
  await chip.getByRole('button', { name: 'Fix' }).click();
  await expect(screen).toContainText(printing('fixed'));
  await expect(chip).toBeHidden();
  await expect(screen).not.toContainText('fixed-42');
  await w.keyboard.press('Enter');
  await expect(screen).toContainText('fixed-42');
  // The command that ran passed: no new mark, no chip.
  await expect(panel.locator('.xterm-decoration.bg-danger')).toHaveCount(1);
  await expect(chip).toBeHidden();

  // A right-click on a selection adds it to the message.
  const row = await panel.locator('.xterm-rows > div', { hasText: 'fixed-42' }).last().boundingBox();
  if (!row) throw new Error('The output line is not on screen');
  await w.mouse.move(row.x + 2, row.y + row.height / 2);
  await w.mouse.down();
  await w.mouse.move(row.x + row.width - 2, row.y + row.height / 2, { steps: 5 });
  await w.mouse.up();
  await panel.locator('.xterm').click({ button: 'right' });
  await w.getByRole('menuitem', { name: 'Add to message' }).click();
  await expect(w.getByRole('button', { name: 'Remove terminal-selection.txt' })).toBeVisible();
});
