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

const JS_PROJECT = { 'src/health.js': 'export function health() {\n  return { status: 200 };\n}\n', 'src/other.js': 'export const other = 1;\n' };

let provider: MockProvider | undefined;
let graft: LaunchedApp | undefined;

/** Starts Graft in a new project with these files. `trusted` marks it as one the language server may run in. */
async function start(files: Record<string, string>, trusted = false): Promise<{ w: Page; model: MockProvider }> {
  const model = await MockProvider.start();
  provider = model;
  const project = makeGitProject(files);
  const app = await launchGraft();
  graft = app;
  await completeOnboarding(app, model, { project });
  if (trusted) {
    await app.window.evaluate(async (folder) => {
      const bridge = (window as unknown as { graft: { invoke(channel: string, input?: unknown): Promise<{ ok: boolean; value: Array<{ id: string; path: string }> }> } }).graft;
      const projects = (await bridge.invoke('projects:list')).value;
      const selected = projects.find((item) => item.path === folder);
      if (!selected || !(await bridge.invoke('projects:update', { id: selected.id, trusted: true })).ok) throw new Error('Could not trust the project');
    }, project);
  }
  return { w: app.window, model };
}

/** Sends a first message, so the session and its folder are on screen. */
async function open(w: Page, model: MockProvider): Promise<void> {
  model.script({ text: 'Hi.' });
  await w.getByRole('textbox', { name: 'Describe a task or ask a question' }).fill('hello');
  await w.keyboard.press('Enter');
  await expect(w.getByText('Hi.', { exact: true })).toBeVisible();
}

test.afterEach(async () => {
  await graft?.close();
  await provider?.close();
});

test('comments on lines go to the agent with the next message, and commands leave them waiting', async () => {
  const { w, model } = await start(JS_PROJECT);
  const provider = model;
  provider.script(
    { toolCalls: [{ name: 'Read', input: { file_path: 'src/health.js' } }] },
    { toolCalls: [{ name: 'Edit', input: { file_path: 'src/health.js', old_string: 'status: 200', new_string: 'status: 500' } }] },
    { text: 'Changed.' },
    { text: 'Fixed.' },
    { text: 'Addressed.' }
  );
  await w.getByRole('textbox', { name: 'Describe a task or ask a question' }).fill('change the status');
  await w.keyboard.press('Enter');
  await w.getByRole('alertdialog').getByRole('button', { name: /Allow once/ }).click();
  await expect(w.getByText('Changed.')).toBeVisible();

  // A line of the diff in the Changes panel takes a comment. The removed line and the added one are both line 2: the last is the added one.
  await w.keyboard.press('Control+Shift+D');
  const changes = w.getByRole('region', { name: 'Changes', exact: true });
  await changes.getByRole('button', { name: /health\.js \(/ }).click();
  await changes.getByRole('button', { name: 'Comment on line 2' }).last().click();
  const box = changes.getByRole('textbox', { name: 'Comment for the agent' });
  await expect(box).toBeFocused();
  await expect(changes.getByRole('button', { name: 'Add comment' })).toBeDisabled();
  await box.fill('Use 503 here.');
  await w.keyboard.press('Control+Enter');
  await expect(changes.getByText('Use 503 here.')).toBeVisible();
  const waiting = w.getByRole('region', { name: 'Comments waiting for your next message' });
  await expect(waiting.getByRole('button', { name: /^1 comment/ })).toBeVisible();
  await shot(w, 'review-comment');

  // A saved comment is edited where it sits. Escape in the box cancels the edit and nothing else.
  await changes.getByRole('button', { name: 'Edit', exact: true }).click();
  await changes.getByRole('textbox', { name: 'Comment for the agent' }).fill('Never mind.');
  await w.keyboard.press('Escape');
  await expect(changes.getByText('Use 503 here.')).toBeVisible();

  // A command leaves the comment waiting.
  await w.getByRole('textbox', { name: SESSION_BOX }).fill('/cost');
  await w.keyboard.press('Enter');
  await expect(waiting.getByRole('button', { name: /^1 comment/ })).toBeVisible();
  expect(provider.chatRequests()).toHaveLength(3);

  // It is kept in the window's storage, then goes with the next message and is gone from both.
  expect(await w.evaluate(() => localStorage.getItem('graft.review.v1'))).toContain('Use 503 here.');
  await w.getByRole('textbox', { name: SESSION_BOX }).fill('Please fix it.');
  await w.keyboard.press('Enter');
  await expect(w.getByText('Fixed.')).toBeVisible();
  expect(JSON.stringify(provider.chatRequests().at(-1)?.body)).toContain('Please fix it.\\n\\nComments on the code:\\n- src/health.js:2 `return { status: 500 };` — Use 503 here.');
  await expect(waiting).toHaveCount(0);
  expect(await w.evaluate(() => localStorage.getItem('graft.review.v1'))).not.toContain('Use 503 here.');

  // A comment from the editor, on the cursor's line, with the key.
  await changes.getByRole('tab', { name: 'Files' }).click();
  await changes.getByRole('treeitem', { name: /src/ }).getByRole('button').first().click();
  await changes.getByRole('treeitem', { name: /other\.js/ }).getByRole('button', { name: /^other\.js/ }).click();
  await changes.getByRole('button', { name: 'Edit file', exact: true }).click();
  await w.getByRole('textbox', { name: 'Edit src/other.js' }).focus();
  await w.keyboard.press('Control+l');
  const dialog = w.getByRole('dialog', { name: 'Comment for the agent' });
  await expect(dialog.getByText('src/other.js:1')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Comment for the agent' }).fill('Export a function instead.');
  await dialog.getByRole('button', { name: 'Add comment' }).click();
  await expect(dialog).toHaveCount(0);

  // And one under the edit in the transcript, on the removed line.
  const log = w.getByRole('log', { name: 'Conversation' });
  await log.getByRole('button', { name: 'Open health.js' }).scrollIntoViewIfNeeded();
  await log.getByRole('region', { name: 'Files changed in this turn' }).getByRole('button', { name: /health\.js/ }).first().click();
  await log.getByRole('button', { name: 'Comment on line 2' }).first().click();
  await log.getByRole('textbox', { name: 'Comment for the agent' }).fill('Why was this 200?');
  await log.getByRole('button', { name: 'Add comment' }).click();
  await expect(waiting.getByRole('button', { name: /^2 comments/ })).toBeVisible();

  // The list names each place; one can be deleted; Send comments sends them with nothing typed.
  await waiting.getByRole('button', { name: /^2 comments/ }).click();
  const list = w.getByRole('list', { name: 'Comments for the agent' });
  await expect(list.getByText('src/health.js:2 (removed)')).toBeVisible();
  await expect(list.getByText('src/other.js:1')).toBeVisible();
  await shot(w, 'review-list');
  await list.getByRole('listitem').filter({ hasText: 'Why was this 200?' }).getByRole('button', { name: 'Delete comment' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await w.getByRole('button', { name: 'Send comments' }).click();
  await expect(w.getByText('Addressed.')).toBeVisible();
  expect(JSON.stringify(provider.chatRequests().at(-1)?.body)).toContain('Address these comments.\\n\\nComments on the code:\\n- src/other.js:1 `export const other = 1;` — Export a function instead.');
  await expect(waiting).toHaveCount(0);
});

test('a file opens by name with Ctrl+P, at a line when one is given', async () => {
  const { w, model } = await start(JS_PROJECT);
  await open(w, model);
  await w.keyboard.press('Control+p');
  const palette = w.getByRole('dialog', { name: 'Command palette' });
  const box = palette.getByRole('combobox', { name: 'Open a file' });
  await expect(box).toBeFocused();
  // With nothing typed it lists the project's files; typed text is matched loosely, as "@" matches it.
  await expect(palette.getByRole('option')).toHaveCount(2);
  await box.fill('othr');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await expect(palette.getByRole('option').first()).toContainText('other.js');
  await shot(w, 'review-quick-open');
  await w.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(w.getByRole('tab', { name: 'src/other.js' })).toHaveAttribute('aria-selected', 'true');

  // The file that is open comes first when nothing is typed. A line after the name opens the editor there.
  await w.keyboard.press('Control+p');
  await expect(palette.getByRole('option').first()).toContainText('other.js');
  await box.fill('health:2');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await w.keyboard.press('Enter');
  await expect(w.getByRole('tab', { name: 'src/health.js' })).toHaveAttribute('aria-selected', 'true');
  await expect(w.locator('.monaco-editor .line-numbers.active-line-number')).toHaveText('2');

  // A name no file has says so. ">" first turns the palette into the command palette, keeping what follows.
  await w.keyboard.press('Control+p');
  await box.fill('nothing-like-this');
  await expect(palette.getByText('No file matches "nothing-like-this".')).toBeVisible();
  await box.fill('>theme');
  await expect(palette.getByRole('combobox', { name: 'Command' })).toHaveValue('theme');
  await expect(palette.getByRole('combobox', { name: 'Command' })).toBeFocused();
  await w.keyboard.press('Escape');

  // The command palette lists both ways in, and this one opens the file palette again.
  await w.keyboard.press('Control+Shift+p');
  await palette.getByRole('combobox', { name: 'Command' }).fill('open a file by name');
  await w.keyboard.press('Enter');
  await expect(box).toBeFocused();
  // "@" first turns it into the symbol palette, which this project is not trusted for.
  await box.fill('@health');
  await expect(palette.getByRole('combobox', { name: 'Go to a symbol' })).toHaveValue('health');
  await expect(palette.getByText('Go to symbol needs a trusted project.')).toBeVisible();
  await w.keyboard.press('Escape');

  // Problems are the language server's too: in a project that is not trusted the tab says so and checks nothing.
  // The panel is open already, on the file that was opened.
  const panel = w.getByRole('region', { name: 'Changes', exact: true });
  await panel.getByRole('tab', { name: 'Problems' }).click();
  await expect(panel.getByText('Problems need a trusted project.')).toBeVisible();
});

test('a symbol opens by name with Ctrl+T in a trusted project', async () => {
  const { w, model } = await start(
    {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' } }),
      'README.md': '# Fixture\n',
      'src/a.ts': 'export function double(n: number): number {\n  return n * 2;\n}\n'
    },
    true
  );
  await open(w, model);
  await w.keyboard.press('Control+t');
  const palette = w.getByRole('dialog', { name: 'Command palette' });
  const box = palette.getByRole('combobox', { name: 'Go to a symbol' });
  await expect(palette.getByText('Type two letters of a name or more.')).toBeVisible();
  await box.fill('doub');
  // The language server starts on the first question.
  await expect(palette.getByRole('option').first()).toContainText('double', { timeout: 60_000 });
  await expect(palette.getByRole('option').first()).toContainText('function');
  await expect(palette.getByRole('option').first()).toContainText('src/a.ts:1');
  await shot(w, 'review-symbol');
  await w.keyboard.press('Enter');
  await expect(w.getByRole('tab', { name: 'src/a.ts' })).toHaveAttribute('aria-selected', 'true');
  await expect(w.locator('.monaco-editor .line-numbers.active-line-number')).toHaveText('1');

  await w.keyboard.press('Control+t');
  await box.fill('nothingnamedthis');
  await expect(palette.getByText('No symbol matches "nothingnamedthis".')).toBeVisible({ timeout: 30_000 });
});

test('the problems of the changed files are listed, open their place and are handed to the message box', async () => {
  const { w, model } = await start(
    {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' } }),
      'src/a.ts': 'export function double(n: number): number {\n  return n * 2;\n}\n'
    },
    true
  );
  model.script({ toolCalls: [{ name: 'Write', input: { file_path: 'src/b.ts', content: "import { double } from './a';\nexport const wrong: string = double(2);\n" } }] }, { text: 'Written.' });
  await w.getByRole('textbox', { name: 'Describe a task or ask a question' }).fill('write b');
  await w.keyboard.press('Enter');
  await w.getByRole('alertdialog').getByRole('button', { name: /Allow once/ }).click();
  await expect(w.getByText('Written.', { exact: true })).toBeVisible({ timeout: 60_000 });

  await w.keyboard.press('Control+Shift+D');
  const panel = w.getByRole('region', { name: 'Changes', exact: true });
  await panel.getByRole('tab', { name: 'Problems' }).click();
  const row = panel.getByRole('button', { name: /Type 'number' is not assignable to type 'string'\./ });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText('2:14');
  await expect(row).toContainText('(2322)');
  await expect(row.getByRole('img', { name: 'Error' })).toBeVisible();
  await expect(panel.getByRole('tab', { name: 'Problems (1)' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('1 problem in 1 changed file')).toBeVisible();
  await shot(w, 'review-problems');

  // The button writes the request into the message box and sends nothing.
  const asked = model.chatRequests().length;
  await panel.getByRole('button', { name: 'Ask Graft to fix these' }).click();
  const box = w.getByRole('textbox', { name: SESSION_BOX });
  await expect(box).toHaveValue("Fix these problems:\n- src/b.ts:2:14 Type 'number' is not assignable to type 'string'. (2322)");
  await expect(box).toBeFocused();
  expect(model.chatRequests()).toHaveLength(asked);

  // A row opens its file in the editor at the problem.
  await row.click();
  await expect(w.getByRole('tab', { name: 'src/b.ts' })).toHaveAttribute('aria-selected', 'true');
  await expect(w.locator('.monaco-editor .line-numbers.active-line-number')).toHaveText('2');
  await expect(panel.getByRole('tab', { name: 'Problems (1)' })).toHaveAttribute('aria-selected', 'false');
});
