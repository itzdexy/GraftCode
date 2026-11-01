import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider, requestText } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');
/** The message box of a code session with a project folder, by its label. */
const SESSION_BOX = /^Ask anything/;

/** A picture of the window once what is arriving has arrived. */
async function shot(w: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await w.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.timeline === document.timeline && a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
  await w.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const A = 'export const a = 1;\n';
const B = 'export const b = 1;\n';

let provider: MockProvider | undefined;
let graft: LaunchedApp | undefined;

test.afterEach(async () => {
  await graft?.close();
  await provider?.close();
});

test('a review lists its findings, Fix sends one with the next message, and a turn is undone a file and a change at a time', async () => {
  const model = await MockProvider.start();
  provider = model;
  const project = makeGitProject({ 'src/a.js': A, 'src/b.js': B });
  graft = await launchGraft();
  await completeOnboarding(graft, model, { project });
  const w = graft.window;
  const read = (file: string): string => fs.readFileSync(path.join(project, file), 'utf8');

  // A turn changes two files (an edit needs the file read first).
  model.script(
    {
      toolCalls: [
        { name: 'Read', input: { file_path: 'src/a.js' } },
        { name: 'Read', input: { file_path: 'src/b.js' } }
      ]
    },
    {
      toolCalls: [
        { name: 'Edit', input: { file_path: 'src/a.js', old_string: 'a = 1', new_string: 'a = 2' } },
        { name: 'Edit', input: { file_path: 'src/b.js', old_string: 'b = 1', new_string: 'b = 2' } }
      ]
    },
    { text: 'Changed both.' }
  );
  await w.getByRole('textbox', { name: 'Describe a task or ask a question' }).fill('change both');
  await w.keyboard.press('Enter');
  await w.getByRole('alertdialog', { name: 'Edit src/a.js' }).getByRole('button', { name: /Allow once/ }).click();
  await w.getByRole('alertdialog', { name: 'Edit src/b.js' }).getByRole('button', { name: /Allow once/ }).click();
  await expect(w.getByText('Changed both.')).toBeVisible();

  // The Changes panel asks for a review of what is uncommitted. The review tries an edit, which is refused
  // without a question, then reports what it found.
  const findings = [
    { path: 'src/b.js', line: 1, severity: 'high', title: 'Wrong export', detail: 'Importers read b as 2, so totals double.', suggestion: 'Export 1 again.' },
    { path: 'src/a.js', line: 1, severity: 'low', title: 'Magic number', detail: 'The 2 has no name.' }
  ];
  model.script(
    { toolCalls: [{ name: 'Edit', input: { file_path: 'src/a.js', old_string: 'a = 2', new_string: 'a = 3' } }] },
    { toolCalls: [{ name: 'ReportFindings', input: { findings, summary: 'Checked both exports.' } }] },
    { text: 'Two problems.' },
    { text: 'Fixed.' }
  );
  await w.keyboard.press('Control+Shift+D');
  const changes = w.getByRole('region', { name: 'Changes', exact: true });
  await changes.getByRole('button', { name: 'Review changes' }).click();
  await expect(w.getByText('Two problems.')).toBeVisible();
  expect(read('src/a.js')).toBe('export const a = 2;\n');
  const reviewRequests = model.chatRequests().slice(-3);
  expect(requestText(reviewRequests[0]?.body)).toContain('Review the uncommitted changes in this repository.');
  expect(JSON.stringify(reviewRequests[0]?.body)).toContain('"ReportFindings"');
  expect(requestText(reviewRequests[1]?.body)).toContain('This review is read-only, so nothing can be changed while it runs.');

  // The card counts the findings by severity and groups them by file, worst first.
  const card = w.getByRole('region', { name: 'Review findings' });
  await expect(card.getByText('2 findings')).toBeVisible();
  await expect(card.getByText('1 high')).toBeVisible();
  await expect(card.getByText('1 low')).toBeVisible();
  await expect(card.getByText('Checked both exports.')).toBeVisible();
  await expect(card.getByRole('list', { name: 'Findings in src/b.js' }).getByText('Importers read b as 2, so totals double.')).toBeVisible();
  await expect(card.getByRole('list', { name: 'Findings in src/a.js' }).getByText('Magic number')).toBeVisible();
  await shot(w, 'review-findings');

  // Its place opens the file at the line.
  await card.getByRole('button', { name: 'src/b.js:1' }).click();
  await expect(w.getByRole('tab', { name: 'src/b.js' })).toHaveAttribute('aria-selected', 'true');

  // Dismiss sets one aside, and Restore brings it back.
  await card.getByRole('button', { name: 'Dismiss: Magic number' }).click();
  await expect(card.getByRole('button', { name: 'Restore: Magic number' })).toBeVisible();
  await card.getByRole('button', { name: 'Restore: Magic number' }).click();
  await card.getByRole('button', { name: 'Dismiss: Magic number' }).click();

  // Fix puts the finding into the next message, as a comment on its line.
  await card.getByRole('button', { name: 'Fix: Wrong export' }).click();
  await expect(card.getByText('Added to your next message')).toBeVisible();
  const waiting = w.getByRole('region', { name: 'Comments waiting for your next message' });
  await expect(waiting.getByRole('button', { name: /^1 comment/ })).toBeVisible();
  await w.getByRole('textbox', { name: SESSION_BOX }).fill('Please fix it.');
  await w.keyboard.press('Enter');
  await expect(w.getByText('Fixed.', { exact: true })).toBeVisible();
  expect(requestText(model.chatRequests().at(-1)?.body)).toContain(
    'Please fix it.\n\nComments on the code:\n- src/b.js:1 — Fix this high-severity finding: Wrong export. Importers read b as 2, so totals double. Suggested fix: Export 1 again.'
  );
  await expect(waiting).toHaveCount(0);

  // Undo on one file of the first turn puts that file back from the turn's snapshot, and only that file.
  const turn = w.getByRole('region', { name: 'Files changed in this turn' });
  await turn.getByRole('button', { name: 'Undo changes to a.js' }).click();
  const dialog = w.getByRole('dialog', { name: 'Undo the changes to src/a.js?' });
  await expect(dialog.getByText('src/a.js', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('radiogroup')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(turn.getByText('Undone')).toBeVisible();
  expect(read('src/a.js')).toBe(A);
  expect(read('src/b.js')).toBe('export const b = 2;\n');
  await expect(turn.getByRole('button', { name: 'Undo changes to a.js' })).toHaveCount(0);

  // Undo on one change of the other file takes just that change back out.
  await turn.getByRole('button', { name: /b\.js/ }).first().click();
  await turn.getByRole('button', { name: 'Undo this change to b.js' }).click();
  await expect(turn.getByText('Undone')).toHaveCount(2);
  expect(read('src/b.js')).toBe(B);
  await shot(w, 'review-undo');
});
