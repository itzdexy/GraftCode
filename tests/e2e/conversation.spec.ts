import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');
/** The message box of a code session with a project folder, by its label. */
const SESSION_BOX = /^Ask anything/;

/**
 * A picture of the window once what is arriving has arrived: a frame taken mid-entrance shows things half faded.
 * Only animations that run in time: a scroll-linked edge fade never finishes.
 */
async function shot(w: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await w.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.timeline === document.timeline && a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  await w.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

let provider: MockProvider;
let graft: LaunchedApp;

test.beforeEach(async () => {
  provider = await MockProvider.start();
  const project = makeGitProject({
    'src/health.js': `${Array.from({ length: 30 }, (_, i) => `// line ${String(i + 1)}`).join('\n')}\n`,
    'a/index.js': '',
    'b/index.js': ''
  });
  graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
});

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

// One reply that carries everything: names of files, money beside a formula, a command, a long block for a file, a Mermaid block.
const REPLY = [
  'See `src/health.js:14`, `health.js`, `index.js` and `nope.js`. It costs $5 and $10, and $e^{i\\pi} + 1 = 0$.',
  '',
  '```bash',
  'echo graft-$((6*7))',
  '```',
  '',
  '```js src/health.js',
  Array.from({ length: 45 }, (_, i) => `const line${String(i + 1)} = ${String(i + 1)};`).join('\n'),
  '```',
  '',
  '```mermaid',
  'graph TD',
  '  A --> B',
  '```'
].join('\n');

test('a reply is something to work in: files open, code folds and reaches the terminal, find finds, math is set', async () => {
  const w = graft.window;
  provider.script({ text: REPLY }, { text: 'Drawn.' });
  await w.getByRole('textbox', { name: 'Describe a task or ask a question' }).fill('show me');
  await w.keyboard.press('Enter');
  const log = w.getByRole('log', { name: 'Conversation' });

  // Names of files that exist once are links; a name two files share, and one no file has, stay code.
  await expect(log.getByRole('button', { name: 'src/health.js:14' })).toHaveAttribute('title', 'Open src/health.js at line 14');
  await expect(log.getByRole('button', { name: 'health.js', exact: true })).toHaveAttribute('title', 'Open src/health.js');
  await expect(log.getByRole('button', { name: 'index.js', exact: true })).toHaveCount(0);
  await expect(log.getByRole('button', { name: 'nope.js', exact: true })).toHaveCount(0);
  await expect(log.getByText('index.js', { exact: true })).toBeVisible();

  // Money stays text; the formula is set.
  await expect(log.getByText('It costs $5 and $10')).toBeVisible();
  await expect(log.locator('.katex')).toHaveCount(1);
  await expect(log.locator('.katex-error')).toHaveCount(0);
  await shot(w, 'conversation-reply');

  // The long block names its file, says how long it is, is folded, and unfolds. Copy would still copy all of it.
  const block = log.locator('.group\\/code').filter({ hasText: 'const line1 = 1;' });
  await expect(block.getByRole('button', { name: 'src/health.js', exact: true })).toHaveAttribute('title', 'Open src/health.js');
  await expect(block.getByText('45 lines', { exact: true })).toBeVisible();
  await expect(block.getByText('const line20 = 20;')).toBeVisible();
  await expect(block.getByText('const line21 = 21;')).toHaveCount(0);
  await block.getByRole('button', { name: 'Show all 45 lines' }).click();
  await expect(block.getByText('const line45 = 45;')).toBeVisible();
  await expect(block.getByRole('button', { name: 'Show fewer lines' })).toBeVisible();
  // Lines wrap on request, and the button says which way it is.
  await block.getByRole('button', { name: 'Wrap lines', exact: true }).click();
  await expect(block.getByRole('button', { name: "Don't wrap lines" })).toHaveAttribute('aria-pressed', 'true');
  await expect(block.locator('pre')).toHaveCSS('white-space', 'pre-wrap');
  // A block of several lines is not a command, and only the Mermaid block can be drawn.
  await expect(log.getByRole('button', { name: 'Type into the terminal' })).toHaveCount(1);
  await expect(log.getByRole('button', { name: 'Draw this' })).toHaveCount(1);

  // The name opens the file in the editor, at its line.
  await log.getByRole('button', { name: 'src/health.js:14' }).click();
  await expect(w.getByRole('tab', { name: 'src/health.js' })).toHaveAttribute('aria-selected', 'true');
  await expect(w.locator('.monaco-editor .line-numbers.active-line-number')).toHaveText('14');
  await shot(w, 'conversation-file');

  // The command is typed into the terminal and not run; the keyboard is there, so Enter runs it.
  await log.getByRole('button', { name: 'Type into the terminal' }).click();
  const screen = w.getByRole('region', { name: 'Terminal' }).locator('.xterm-rows');
  await expect(screen).toContainText('echo graft-$((6*7))');
  await expect(screen).not.toContainText('graft-42');
  await w.keyboard.press('Enter');
  await expect(screen).toContainText('graft-42');
  await shot(w, 'conversation-terminal');

  // Find: counts, moves round, marks without touching the page, and leaves no mark behind.
  await w.getByRole('textbox', { name: SESSION_BOX }).click();
  await w.keyboard.press('Control+f');
  const find = w.getByRole('textbox', { name: 'Find in the conversation' });
  await expect(find).toBeFocused();
  await find.fill('CONST LINE4');
  const count = w.getByRole('search', { name: 'Find in the conversation' }).getByText(/^\d of 7$/); // line4 and line40 to line45
  await expect(count).toBeVisible();
  const first = Number((await count.textContent())?.charAt(0));
  await w.keyboard.press('Enter');
  await expect(count).toHaveText(`${String((first % 7) + 1)} of 7`);
  await w.keyboard.press('Shift+Enter');
  await expect(count).toHaveText(`${String(first)} of 7`);
  await shot(w, 'conversation-find');
  expect(await w.evaluate(() => [CSS.highlights.has('graft-find'), CSS.highlights.has('graft-find-current'), document.querySelectorAll('mark').length])).toEqual([true, true, 0]);
  await find.fill('no such text anywhere');
  await expect(w.getByRole('search', { name: 'Find in the conversation' }).getByText('No results')).toBeVisible();
  await w.keyboard.press('Escape');
  await expect(find).toHaveCount(0);
  expect(await w.evaluate(() => CSS.highlights.size)).toBe(0);
  await expect(w.getByRole('textbox', { name: SESSION_BOX })).toBeFocused();

  // The Mermaid block asks for a drawing.
  await log.getByRole('button', { name: 'Draw this' }).click();
  await expect(log.getByText('Drawn.')).toBeVisible();
  expect(JSON.stringify(provider.chatRequests().at(-1)?.body)).toContain('Redraw the Mermaid diagram from your last reply that begins \\"graph TD\\"');
});

test('the editor keeps its own Ctrl+F', async () => {
  const w = graft.window;
  provider.script({ text: 'See `src/health.js:2`.' });
  await w.getByRole('textbox', { name: 'Describe a task or ask a question' }).fill('open it');
  await w.keyboard.press('Enter');
  await w.getByRole('log', { name: 'Conversation' }).getByRole('button', { name: 'src/health.js:2' }).click();
  await expect(w.locator('.monaco-editor .line-numbers.active-line-number')).toHaveText('2');
  await w.locator('.monaco-editor .view-lines').click();
  await w.keyboard.press('Control+f');
  await expect(w.locator('.monaco-editor .find-widget.visible')).toBeVisible();
  await expect(w.getByRole('textbox', { name: 'Find in the conversation' })).toHaveCount(0);
});

test('Escape in the find bar closes it and does not stop a turn that is running', async () => {
  const w = graft.window;
  provider.script({ text: 'Thinking about a long answer', chunkDelayMs: 40, hold: true });
  await w.getByRole('textbox', { name: 'Describe a task or ask a question' }).fill('Start something long');
  await w.keyboard.press('Enter');
  await expect(w.getByText('Thinking about a long answer')).toBeVisible();

  await w.keyboard.press('Control+f');
  const find = w.getByRole('textbox', { name: 'Find in the conversation' });
  await find.fill('long answer');
  await expect(w.getByRole('search', { name: 'Find in the conversation' }).getByText('1 of 1')).toBeVisible();
  // The shortcut pressed again selects what was typed, so typing replaces it.
  await w.keyboard.press('Control+f');
  await w.keyboard.type('thinking');
  await expect(find).toHaveValue('thinking');
  await w.keyboard.press('Escape');
  await expect(find).toHaveCount(0);
  await expect(w.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(w.getByText('Stopped.')).toHaveCount(0);
});
