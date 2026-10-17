import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');
const SESSION_BOX = /^(Ask anything|Queue a message)/;

/** A cube as an ASCII .stl: twelve triangles, two units wide. */
const CRATE = (() => {
  const faces: Array<[number[], number[][]]> = [
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
    [[0, 0, -1], [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]]],
    [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
    [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
    [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]]
  ];
  const lines = ['solid crate'];
  for (const [normal, q] of faces) {
    for (const tri of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
      lines.push(`facet normal ${normal.join(' ')}`, 'outer loop', ...tri.map((v) => `vertex ${(v ?? []).join(' ')}`), 'endloop', 'endfacet');
    }
  }
  lines.push('endsolid crate');
  return `${lines.join('\n')}\n`;
})();

async function shot(w: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  // A frame taken mid-entrance shows things half faded.
  await w.evaluate(() =>
    document.getAnimations().forEach((a) => {
      // A spinner or a pulse runs for ever and can't be finished.
      if (a.effect?.getComputedTiming().endTime !== Infinity) a.finish();
    })
  );
  await w.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

let provider: MockProvider;
let graft: LaunchedApp;

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

test('the details column says where a session runs, what fills its context, what it made and what changed', async () => {
  provider = await MockProvider.start();
  const project = makeGitProject();
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider, { project });

  provider.script({ toolCalls: [{ name: 'Write', input: { file_path: 'notes/plan.md', content: '# Plan\n' } }] }, { text: 'Wrote the plan.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Write the plan');
  await composer.press('Enter');
  await w.getByRole('alertdialog').getByRole('button', { name: /Allow once/ }).click();
  await expect(w.getByText('Wrote the plan.')).toBeVisible();

  const details = w.getByRole('complementary', { name: 'Session details' });
  await expect(details).toBeVisible();
  const environment = details.getByRole('region', { name: 'Environment' });
  await expect(environment.getByText('This computer')).toBeVisible();
  await expect(environment.getByText(path.basename(project))).toBeVisible();
  await expect(environment.getByText('main', { exact: true })).toBeVisible();

  // What the session made, and what it changed in the folder.
  await expect(details.getByRole('region', { name: 'Outputs' }).getByText('plan.md')).toBeVisible();
  const changes = details.getByRole('region', { name: 'Changes' });
  await expect(changes.getByText('in 1 file')).toBeVisible();
  await expect(changes.getByRole('button', { name: 'Create PR' })).toBeVisible();
  // The bar under the transcript gives way: the column holds the branch and the changes.
  await expect(w.getByRole('button', { name: 'Hide git status' })).toHaveCount(0);

  // The context opens to its parts, with how far automatic compaction is.
  const context = details.getByRole('region', { name: 'Context' });
  await context.getByRole('button', { name: /^Context/ }).click();
  await expect(context.getByText(/% used$/)).toBeVisible();
  await expect(context.getByText('Free space')).toBeVisible();
  await expect(context.getByText(/until Graft compacts$|^Window size unknown$/)).toBeVisible();
  await expect(context.getByRole('button', { name: 'Compact session' })).toBeEnabled();
  await expect(details.getByRole('region', { name: 'Connectors' }).getByText('None')).toBeVisible();
  await shot(w, 'session-details');

  // A panel takes its place, and gives it back when it closes.
  await w.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(details).toBeHidden();
  await expect(w.getByRole('button', { name: 'Hide git status' })).toBeVisible();
  await w.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(details).toBeVisible();

  // The header button hides it and brings it back.
  await w.getByRole('button', { name: 'Session details' }).click();
  await expect(details).toBeHidden();
  await expect(w.getByRole('button', { name: 'Hide git status' })).toBeVisible();
  await w.getByRole('button', { name: 'Session details' }).click();
  await expect(details).toBeVisible();
});

test('several queued messages fold into one line that opens, and can all be cleared', async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider, { project: makeGitProject() });

  provider.script({ text: 'Thinking about a long answer', chunkDelayMs: 40, hold: true });
  const start = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await start.fill('Start something long');
  await start.press('Enter');
  await expect(w.getByText('Thinking about a long answer')).toBeVisible();

  const box = w.getByRole('textbox', { name: SESSION_BOX });
  for (const text of ['Then add tests for the parser', 'After that, update the README', 'Finally commit everything']) {
    await box.fill(text);
    await box.press('Enter');
  }
  const queue = w.getByRole('region', { name: 'Queued messages' });
  const head = queue.getByRole('button', { name: /3 messages queued/ });
  await expect(head).toBeVisible();
  await expect(head).toContainText('Next: Then add tests for the parser');
  await expect(head).toHaveAttribute('aria-expanded', 'false');

  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(queue.getByRole('listitem')).toHaveCount(3);
  await expect(queue.getByRole('button', { name: 'Edit' })).toHaveCount(3);
  await shot(w, 'queue-open');

  await queue.getByRole('button', { name: 'Clear all' }).click();
  await expect(queue.getByText('Remove all 3 queued messages?')).toBeVisible();
  await queue.getByRole('button', { name: 'Remove all' }).click();
  await expect(w.getByRole('region', { name: 'Queued messages' })).toHaveCount(0);

  const closed = provider.waitForHeldStreamClosed();
  await w.getByRole('button', { name: 'Stop' }).click();
  await closed;
  // Nothing that was cleared went to the model.
  expect(JSON.stringify(provider.chatRequests().map((r) => r.body))).not.toContain('Finally commit everything');
});

test('a 3D model named in a reply is drawn where the turn ends, and opens in the Files panel', async () => {
  provider = await MockProvider.start();
  const project = makeGitProject({ 'notes.txt': 'hello\n', 'models/crate.stl': CRATE });
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider, { project });

  provider.script({ text: 'Exported the crate to `models/crate.stl`; it stands on the floor at the origin.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Export the crate');
  await composer.press('Enter');
  await expect(w.getByText(/Exported the crate to/)).toBeVisible();

  const card = w.getByRole('region', { name: '3D models from this turn' });
  await expect(card).toBeVisible();
  const view = card.getByRole('group', { name: '3D view of crate.stl' });
  await expect(view).toBeVisible();
  // Drawn with WebGL where the computer has it; said plainly where it hasn't (a container without a GPU).
  const drawn = view.getByText('12 triangles · 1 mesh · 1 material');
  const refused = view.getByRole('alert');
  await expect(drawn.or(refused)).toBeVisible({ timeout: 20_000 });
  if (await drawn.isVisible()) {
    await expect(view.getByText('2 × 2 × 2')).toBeVisible();
    await expect(view.locator('canvas')).toHaveCount(1);
    const toolbar = view.getByRole('toolbar', { name: '3D view' });
    await toolbar.getByRole('button', { name: 'Wireframe' }).click();
    await expect(toolbar.getByRole('button', { name: 'Wireframe' })).toHaveAttribute('aria-pressed', 'true');
  } else {
    await expect(refused).toContainText("can't draw 3D");
  }
  await shot(w, 'models-card');

  // The same model in the Files panel, where the session's files are browsed.
  await card.getByRole('button', { name: 'Open in Files' }).click();
  const panel = w.getByRole('complementary', { name: 'Panels' });
  await expect(panel.getByRole('group', { name: '3D view of crate.stl' })).toBeVisible();
  await expect(panel.getByRole('group', { name: '3D view of crate.stl' }).getByText('12 triangles · 1 mesh · 1 material').or(panel.getByRole('alert'))).toBeVisible({ timeout: 20_000 });
  await shot(w, 'models-files');
});
