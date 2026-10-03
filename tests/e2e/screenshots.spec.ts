import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, makeTempDir, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding } from './support/onboard';

/**
 * Screenshots for the README, taken from the real app driving a scripted
 * model through real tools. Skipped unless GRAFT_SCREENSHOTS=1:
 *
 *   GRAFT_SCREENSHOTS=1 npx playwright test screenshots
 */
const OUT = path.join(__dirname, '..', '..', 'test-results', 'screenshots');
const SIZE = { width: 1440, height: 900 };

test.skip(!process.env.GRAFT_SCREENSHOTS, 'Set GRAFT_SCREENSHOTS=1 to take the README screenshots.');

let provider: MockProvider;
let graft: LaunchedApp;

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

async function snap(w: Page, name: string): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  // Let entrances and the mascot's first frame settle.
  await w.waitForTimeout(700);
  await w.screenshot({ path: path.join(OUT, `${name}.png`) });
}

/** Waits for `done` while approving each action the session asks about. */
async function approveUntil(w: Page, done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 60 && !(await done()); i++) {
    const allow = w.getByRole('button', { name: /Allow once/ });
    if (await allow.isVisible().catch(() => false)) await allow.click();
    await w.waitForTimeout(250);
  }
}

/** A git repository in a folder with a real project name (it shows in the sidebar and chips). */
function makeProject(name: string, files: Record<string, string>): string {
  const dir = path.join(makeTempDir('graft-shots-'), name);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('add', '-A');
  git('commit', '-q', '-m', 'Health check');
  return dir;
}

async function palette(w: Page, query: string): Promise<void> {
  await w.keyboard.press('ControlOrMeta+Shift+P');
  await w.getByRole('combobox', { name: 'Command' }).fill(query);
  await w.keyboard.press('Enter');
}

const HEALTH = `export async function health(db) {
  const ok = await db.ping();
  return { status: 200, body: { database: ok ? 'up' : 'down' } };
}
`;

const HEALTH_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { health } from '../src/health.js';

test('reports the database as up', async () => {
  const result = await health({ ping: async () => true });
  assert.deepEqual(result, { status: 200, body: { database: 'up' } });
});
`;

test('README screenshots', async () => {
  test.setTimeout(240_000);
  provider = await MockProvider.start({ models: ['qwen3-coder', 'qwen3-coder-flash'] });
  const project = makeProject('acme-api', {
    'package.json': '{\n  "name": "acme-api",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
    'src/health.js': HEALTH,
    'test/health.test.js': HEALTH_TEST,
    'README.md': '# acme-api\n\nThe API behind Acme’s storefront.\n'
  });
  graft = await launchGraft();
  const w = graft.window;
  await graft.app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.unmaximize();
    win?.setContentSize(s.width, s.height);
  }, SIZE);
  await completeOnboarding(graft, provider, { project, model: /^Qwen3 Coder(?! Flash)/ });
  await palette(w, 'theme dark');

  // A code session: read, fix, test, report.
  provider.titleText = 'Health check reports degraded';
  provider.script(
    {
      text: 'I’ll read the health check and its test first.',
      toolCalls: [
        { name: 'Read', input: { file_path: 'src/health.js' } },
        { name: 'Read', input: { file_path: 'test/health.test.js' } }
      ]
    },
    {
      text: 'A failed ping throws out of `health()`, so the route answers 500. I’ll catch it and report the database as degraded.',
      toolCalls: [
        {
          name: 'Edit',
          input: {
            file_path: 'src/health.js',
            old_string: "  const ok = await db.ping();\n  return { status: 200, body: { database: ok ? 'up' : 'down' } };",
            new_string:
              "  try {\n    const ok = await db.ping();\n    return { status: 200, body: { database: ok ? 'up' : 'down' } };\n  } catch {\n    return { status: 200, body: { database: 'degraded' } };\n  }"
          }
        }
      ]
    },
    {
      toolCalls: [
        {
          name: 'Edit',
          input: {
            file_path: 'test/health.test.js',
            old_string: "  assert.deepEqual(result, { status: 200, body: { database: 'up' } });\n});",
            new_string:
              "  assert.deepEqual(result, { status: 200, body: { database: 'up' } });\n});\n\ntest('reports degraded when the database is unreachable', async () => {\n  const result = await health({ ping: async () => { throw new Error('ECONNREFUSED'); } });\n  assert.deepEqual(result, { status: 200, body: { database: 'degraded' } });\n});"
          }
        }
      ]
    },
    { toolCalls: [{ name: 'Shell', input: { command: 'node --test', description: 'Run the tests' } }] },
    {
      text: 'Fixed. **`health()`** now catches a failed database ping and reports `degraded`, so `/health` answers with the state instead of a 500.\n\n- `src/health.js`: the ping runs inside `try`/`catch`\n- `test/health.test.js`: a new test for an unreachable database\n\n`node --test`: 2 passed.'
    }
  );
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('The /health endpoint returns 500 when the database is down. Make it report degraded instead, and add a test.');
  await composer.press('Enter');
  await approveUntil(w, () => w.getByText('node --test: 2 passed.').isVisible());
  await expect(w.getByText('node --test: 2 passed.')).toBeVisible();
  // Unfold the turn's work: each read, edit and command, with its diff or output.
  await w.getByRole('button', { name: /^Ran a command/ }).click();
  await snap(w, 'code-session');

  await w.keyboard.press('ControlOrMeta+Shift+D');
  const changes = w.getByRole('region', { name: /Changes/ });
  await expect(changes).toBeVisible();
  await changes.getByText('health.js', { exact: true }).click();
  await snap(w, 'code-session-changes');
  await w.keyboard.press('ControlOrMeta+Shift+D');

  // The command palette over the session.
  await w.keyboard.press('ControlOrMeta+Shift+P');
  await w.getByRole('combobox', { name: 'Command' }).fill('pal');
  await snap(w, 'command-palette');
  await w.keyboard.press('Escape');

  // A light palette.
  await palette(w, 'theme light');
  await palette(w, 'palette grove');
  await snap(w, 'code-session-light');
  await palette(w, 'theme dark');
  await palette(w, 'palette graft');

  // A chat.
  provider.titleText = 'How hash maps work';
  provider.script({
    text: [
      'A hash map stores values under keys and finds them in about the same time however big it gets.',
      '',
      '1. A **hash function** turns the key into a number.',
      '2. That number picks a **bucket** in an array.',
      '3. Keys that land in the same bucket share it, and a lookup checks the few keys there.',
      '',
      '```ts',
      'const stock = new Map<string, number>();',
      "stock.set('apples', 12);",
      "stock.set('pears', 4);",
      "console.log(stock.get('apples')); // 12",
      '```',
      '',
      'When the buckets fill up, the map grows and spreads its keys again, which keeps lookups fast.'
    ].join('\n')
  });
  await w.getByRole('radio', { name: 'Chat' }).click();
  const chat = w.getByRole('textbox', { name: 'How can I help you today?' });
  await chat.fill('How does a hash map work? Show me a tiny example in TypeScript.');
  await chat.press('Enter');
  await expect(w.getByText(/keeps lookups fast/)).toBeVisible();
  await snap(w, 'chat');

  // Settings → Appearance.
  await palette(w, 'settings appearance');
  await expect(w.getByRole('heading', { name: 'Appearance', level: 2 })).toBeVisible();
  await snap(w, 'appearance');

  // Settings → Integrations.
  await palette(w, 'blender');
  await expect(w.getByRole('heading', { name: 'Integrations', level: 2 }).first()).toBeVisible();
  await snap(w, 'integrations');

  // Customize → Agents, from two templates.
  await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Customize' }).click();
  await w.getByRole('tab', { name: 'Agents' }).click();
  for (const template of ['Code reviewer', 'Test writer']) {
    await w.getByRole('button', { name: 'New agent' }).click();
    await w.getByRole('button', { name: template }).click();
    await w.getByRole('dialog', { name: 'New agent' }).getByRole('button', { name: 'Save' }).click();
    await expect(w.getByRole('dialog', { name: 'New agent' })).toBeHidden();
  }
  await snap(w, 'agents');

  // Code home.
  await w.getByRole('radio', { name: 'Code' }).click();
  await w.keyboard.press('ControlOrMeta+N');
  await expect(w.getByRole('textbox', { name: 'Describe a task or ask a question' })).toBeVisible();
  await snap(w, 'home');
});
