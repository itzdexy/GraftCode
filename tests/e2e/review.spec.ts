import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');
/** The message box of a code session with a project folder, by its label. */
const SESSION_BOX = /^Ask anything/;

/** A picture of the window once what is arriving has arrived: a frame taken mid-entrance shows things half faded. */
async function shot(w: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await w.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  await w.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

let provider: MockProvider;
let graft: LaunchedApp;

test.beforeEach(async () => {
  provider = await MockProvider.start();
  const project = makeGitProject({ 'src/health.js': 'export function health() {\n  return { status: 200 };\n}\n', 'src/other.js': 'export const other = 1;\n' });
  graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
});

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

test('comments on lines go to the agent with the next message, and commands leave them waiting', async () => {
  const w = graft.window;
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
  await w.keyboard.press('Control+Alt+m');
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
