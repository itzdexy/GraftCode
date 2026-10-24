import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchGraft, makeTempDir, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

/** A diagram as the skill writes one: its own template, named, with something drawn in it. */
const PAGE = fs
  .readFileSync(path.join(__dirname, '..', '..', 'resources', 'skills', 'diagram-design', 'assets', 'template.html'), 'utf8')
  .replaceAll('[diagram-slug]', 'orders')
  .replaceAll('[Diagram title]', 'Orders')
  .replace('<!-- Draw arrows first, then nodes. Replace with your content. -->', '<rect x="80" y="80" width="240" height="120" rx="6" fill="#ffffff" stroke="#2d3142"/>');

const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'shots');

async function shot(w: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await w.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

let provider: MockProvider;
let graft: LaunchedApp;

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

/** Makes the native save dialog answer with this file. */
async function saveTo(file: string): Promise<void> {
  await graft.app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
  }, file);
}

test('a diagram the agent writes is shown, opens large, and saves as PNG and SVG', async () => {
  provider = await MockProvider.start();
  const project = makeGitProject();
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider, { project });

  provider.script({ toolCalls: [{ name: 'Write', input: { file_path: 'docs/diagrams/orders (1).html', content: PAGE } }] }, { text: 'Saved the diagram.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('/diagram how an order is paid');
  await composer.press('Enter');
  await w.getByRole('alertdialog').getByRole('button', { name: /Allow once/ }).click();
  await expect(w.getByText('Saved the diagram.')).toBeVisible();
  // The command became the brief, and the session was told about the skill that ships with Graft.
  const first = JSON.stringify(provider.chatRequests()[0]?.body);
  expect(first).toContain('Draw a diagram: how an order is paid');
  expect(first).toContain("Graft's copy of this skill is read-only");

  const card = w.getByRole('region', { name: 'Diagrams from this turn' });
  await expect(card).toBeVisible();
  const frame = card.locator('iframe[title="Diagram: Orders"]');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');

  // The page was given the bundled fonts it names, and told the card how tall it is.
  const inner = card.frameLocator('iframe[title="Diagram: Orders"]');
  await expect(inner.locator('style[data-graft-fonts]')).toHaveCount(1);
  await expect.poll(() => frame.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(100);
  const loaded = await inner.locator('svg[role="img"]').evaluate(async () => {
    await document.fonts.ready;
    const families: string[] = [];
    document.fonts.forEach((face) => {
      if (face.status === 'loaded') families.push(face.family.replace(/['"]/g, ''));
    });
    return families;
  });
  expect(loaded).toEqual(expect.arrayContaining(['Instrument Serif', 'Geist Mono']));

  // Scaled to the card: the conversation never scrolls sideways, and the diagram is at most 520 px high.
  const log = w.getByRole('log', { name: 'Conversation' });
  expect(await log.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await frame.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(520.5);
  await shot(w, 'diagram-card');

  // Copies: a PNG of the diagram alone at twice its size, and an SVG that stands by itself.
  const out = makeTempDir('graft-e2e-diagram-');
  await saveTo(path.join(out, 'orders.png'));
  await card.getByRole('button', { name: 'Save as…' }).click();
  await w.getByRole('menuitem', { name: 'PNG image' }).click();
  await expect.poll(() => fs.existsSync(path.join(out, 'orders.png')), { timeout: 30_000 }).toBe(true);
  await expect(w.getByText('Saved orders.png')).toBeVisible();
  const png = fs.readFileSync(path.join(out, 'orders.png'));
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1920, 1200]);

  await saveTo(path.join(out, 'orders.svg'));
  await card.getByRole('button', { name: 'Save as…' }).click();
  await w.getByRole('menuitem', { name: 'SVG image' }).click();
  await expect.poll(() => fs.existsSync(path.join(out, 'orders.svg'))).toBe(true);
  const svg = fs.readFileSync(path.join(out, 'orders.svg'), 'utf8');
  expect(svg).toMatch(/^<svg viewBox="0 0 960 600" xmlns="http:\/\/www\.w3\.org\/2000\/svg" role="img"/);
  expect(svg).toContain('--color-paper');
  expect(svg.trimEnd().endsWith('</svg>')).toBe(true);

  // The same picture goes on the clipboard.
  await card.getByRole('button', { name: 'Copy image' }).click();
  await expect(w.getByText('Copied the diagram')).toBeVisible();
  const kinds = await graft.app.evaluate(async ({ clipboard }) => (await clipboard.read()).flatMap((item) => item.types));
  expect(kinds).toContain('image/png');

  // The viewer: the same page, large, with zoom.
  await card.getByRole('button', { name: 'Open Orders' }).click();
  const viewer = w.getByRole('dialog', { name: 'Diagram: Orders' });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('iframe[title="Diagram: Orders"]')).toBeVisible();
  const level = viewer.getByRole('toolbar', { name: 'Diagram view' }).locator('[aria-live]');
  await expect(level).toHaveText('Fit');
  await shot(w, 'diagram-viewer');
  await viewer.getByRole('button', { name: 'Zoom in' }).click();
  await expect(level).toHaveText(/^(75|100|150|200)%$/);
  await viewer.getByRole('button', { name: 'Fit', exact: true }).click();
  await expect(level).toHaveText('Fit');
  await w.keyboard.press('Escape');
  await expect(viewer).toBeHidden();

  // A diagram whose file has gone says so instead of asking where to save it.
  fs.rmSync(path.join(project, 'docs', 'diagrams', 'orders (1).html'));
  await card.getByRole('button', { name: 'Save as…' }).click();
  await w.getByRole('menuitem', { name: 'PNG image' }).click();
  await expect(w.getByText('orders (1).html was moved or deleted.')).toBeVisible();
});

test('a chat reads the skill, saves a diagram and shows it', async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider);
  await w.getByRole('radio', { name: 'Chat' }).click();

  provider.script(
    { toolCalls: [{ name: 'Skill', input: { name: 'diagram-design' } }] },
    { toolCalls: [{ name: 'Skill', input: { name: 'diagram-design', file: 'assets/template.html' } }] },
    { toolCalls: [{ name: 'CreateFile', input: { name: 'orders.html', content: PAGE } }] },
    { text: 'Drew the diagram.' }
  );
  const composer = w.getByRole('textbox', { name: 'How can I help you today?' });
  await composer.fill('Draw how an order is paid');
  await composer.press('Enter');
  await expect(w.getByText('Drew the diagram.')).toBeVisible();

  // The chat was told about the skill, and what it read came back as the skill's own text. Nobody was asked.
  const requests = provider.chatRequests();
  expect(JSON.stringify(requests[0]?.body)).toContain('read the diagram-design skill with Skill');
  expect(JSON.stringify((requests[1]?.body as { messages: unknown[] }).messages.slice(-1))).toContain('name: diagram-design');
  expect(JSON.stringify((requests[2]?.body as { messages: unknown[] }).messages.slice(-1))).toContain('viewBox=\\"0 0 960 600\\"');
  await expect(w.getByRole('alertdialog')).toHaveCount(0);

  // The file is listed with the chat's files, and drawn as a diagram after them.
  await expect(w.getByRole('region', { name: 'Files from this reply' }).getByText('orders.html')).toBeVisible();
  const card = w.getByRole('region', { name: 'Diagrams from this turn' });
  const frame = card.locator('iframe[title="Diagram: Orders"]');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(card.frameLocator('iframe[title="Diagram: Orders"]').locator('svg[role="img"]')).toBeVisible();
  await expect.poll(() => frame.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(100);
  await shot(w, 'diagram-chat');

  // A copy is offered in Downloads, since the chat's own file lives in Graft's data folder.
  const out = makeTempDir('graft-e2e-diagram-');
  const target = path.join(out, 'orders.svg');
  await graft.app.evaluate(({ app, dialog }, chosen) => {
    dialog.showSaveDialog = (...args: unknown[]) => {
      const options = args.at(-1) as { defaultPath?: string };
      (globalThis as { askedIn?: boolean }).askedIn = options.defaultPath?.startsWith(app.getPath('downloads')) ?? false;
      return Promise.resolve({ canceled: false, filePath: chosen });
    };
  }, target);
  await card.getByRole('button', { name: 'Save as…' }).click();
  await w.getByRole('menuitem', { name: 'SVG image' }).click();
  await expect.poll(() => fs.existsSync(target)).toBe(true);
  expect(fs.readFileSync(target, 'utf8')).toMatch(/^<svg viewBox="0 0 960 600" xmlns="http:\/\/www\.w3\.org\/2000\/svg" role="img"/);
  expect(await graft.app.evaluate(() => (globalThis as { askedIn?: boolean }).askedIn)).toBe(true);

  await card.getByRole('button', { name: 'More for orders.html' }).click();
  await expect(w.getByRole('menuitem', { name: 'Show in folder' })).toBeVisible();
  await expect(w.getByRole('menuitem', { name: 'Open in browser' })).toBeVisible();
});

test('the skill that ships with Graft is listed in Customize, and cannot be edited there', async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider, { project: makeGitProject() });

  await w.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Customize' }).click();
  await w.getByRole('tab', { name: 'Skills' }).click();
  const skills = w.getByRole('tabpanel', { name: 'Skills' });
  const row = skills.getByRole('listitem').filter({ hasText: 'diagram-design' });
  await expect(row).toBeVisible();
  await expect(row.getByText('Built in')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Show folder' })).toBeVisible();
  await expect(row.getByRole('button', { name: /^(Edit|Delete) / })).toHaveCount(0);
});
