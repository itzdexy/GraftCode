import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

let graft: LaunchedApp | undefined;
let provider: MockProvider | undefined;
test.afterEach(async () => {
  await graft?.close().catch(() => undefined);
  await provider?.close();
});

/**
 * Ends the app the way a crash or the task manager does: at once, with nothing run on the way out.
 * The process Playwright started is a wrapper on Windows, so the app is asked for its own.
 */
async function kill(app: LaunchedApp): Promise<void> {
  const pid = await app.app.evaluate(() => process.pid);
  process.kill(pid, 'SIGKILL');
  const alive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await expect.poll(alive).toBe(false);
}

/** Starts the app again on the same profile, once the killed app's helper processes have let go of it. */
async function relaunch(userData: string, graftHome: string): Promise<LaunchedApp> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await launchGraft({ userData, graftHome });
    } catch (error) {
      if (attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

test('a command that was running when Graft was killed is reported as unknown, to the user and to the model', async () => {
  const project = makeGitProject({ 'notes.txt': 'hello\n' });
  provider = await MockProvider.start();
  graft = await launchGraft();
  await completeOnboarding(graft, provider, { project });
  let w = graft.window;

  // The command leaves a mark when it starts, and takes long enough to be cut off in the middle.
  provider.script({ toolCalls: [{ name: 'Shell', input: { command: 'echo started > started.txt; sleep 8; echo finished > finished.txt', description: 'Run the slow job' } }] });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Run the slow job');
  await composer.press('Enter');
  await w.getByRole('alertdialog').getByRole('button', { name: /Allow once/ }).click();
  await expect.poll(() => fs.existsSync(path.join(project, 'started.txt'))).toBe(true);

  const { userData, graftHome } = graft;
  await kill(graft);
  expect(fs.existsSync(path.join(project, 'finished.txt'))).toBe(false);

  graft = await relaunch(userData, graftHome);
  w = graft.window;
  await w.getByRole('complementary', { name: 'Sidebar' }).getByText('New session', { exact: true }).first().click();
  // The note is already there when the session is opened: nothing has to be sent first.
  await expect(w.getByText(/Graft stopped while this session was working\. Outcome unknown: “[^”]*echo started[^”]*”\./)).toBeVisible();

  provider.script({ text: 'The job had started. I will look at what it left before running it again.' });
  const box = w.getByRole('textbox', { name: /^Ask anything/ });
  await box.fill('What happened to the job?');
  await box.press('Enter');
  await expect(w.getByText('The job had started. I will look at what it left before running it again.')).toBeVisible();

  // The model is told what is known. Before, it was told the command had not run.
  const sent = JSON.stringify(provider.chatRequests().at(-1)!.body);
  expect(sent).toContain('Outcome unknown: Graft stopped while this was running');
  expect(sent).toContain('check what it left behind before you repeat it');
  expect(sent).not.toContain('Not run: the turn was interrupted.');
});
