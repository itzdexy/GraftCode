import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

/**
 * A page that only works for real input: the counter listens for pointerdown
 * (which el.click() never fires), and the greeting follows the input event.
 */
const PAGE = `<!doctype html>
<title>Graft test page</title>
<h1>Sign up</h1>
<label>Your name <input id="name" placeholder="Your name"></label>
<p id="out">Hello, nobody</p>
<button id="go">Count</button>
<p id="count">Count: 0</p>
<script>
  document.getElementById('name').addEventListener('input', (e) => {
    document.getElementById('out').textContent = 'Hello, ' + e.target.value;
  });
  let n = 0;
  document.getElementById('go').addEventListener('pointerdown', () => {
    n += 1;
    document.getElementById('count').textContent = 'Count: ' + n;
  });
  console.error('boom from the test page');
</script>`;

let provider: MockProvider;
let graft: LaunchedApp;
let site: http.Server;
let siteUrl: string;

test.beforeEach(async () => {
  site = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  provider = await MockProvider.start();
  graft = await launchGraft();
  await completeOnboarding(graft, provider, { project: makeGitProject({ 'README.md': '# demo\n' }) });
});

test.afterEach(async () => {
  await graft.close();
  await provider.close();
  await new Promise<void>((resolve) => site.close(() => resolve()));
});

/** What the model was sent back for the tool call before request `index`. */
function toolResultBefore(index: number): string {
  const messages = (provider.chatRequests()[index]!.body as { messages: unknown[] }).messages;
  return JSON.stringify(messages.slice(-1));
}

test('the agent tests a page in the Browser panel: types, clicks with real input and reads the console', async () => {
  const w = graft.window;
  provider.script(
    { toolCalls: [{ name: 'Browser', input: { action: 'open', url: siteUrl } }] },
    { toolCalls: [{ name: 'Browser', input: { action: 'type', ref: 1, text: 'Graft' } }] },
    { toolCalls: [{ name: 'Browser', input: { action: 'click', text: 'Count' } }] },
    { toolCalls: [{ name: 'Browser', input: { action: 'console' } }] },
    { text: 'The sign-up page works.' }
  );
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Check the sign-up page');
  await composer.press('Enter');

  // Opening a page asks first in Ask mode; working with it afterwards doesn't.
  const card = w.getByRole('alertdialog', { name: /^Open http:\/\/127\.0\.0\.1:\d+\/ in the browser$/ });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /Allow once/ }).click();
  await expect(w.getByText('The sign-up page works.')).toBeVisible({ timeout: 30_000 });

  // The panel opened itself on the page the agent used.
  const panel = w.getByRole('region', { name: 'Browser' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Address' })).toHaveValue(siteUrl);
  await expect(panel.getByRole('button', { name: 'Console' })).toBeVisible();

  // Each result carried the real page back to the model.
  const opened = toolResultBefore(1);
  expect(opened).toContain('Graft test page');
  expect(opened).toMatch(/\[1\] input\[text\] \\"Your name\\"/);
  expect(opened).toMatch(/\[2\] button \\"Count\\"/);
  expect(opened).toContain('logged 1 error or warning');
  expect(toolResultBefore(2)).toContain('Hello, Graft');
  // pointerdown only fires for real input events, so this proves the click was one.
  expect(toolResultBefore(3)).toContain('Count: 1');
  expect(toolResultBefore(4)).toContain('boom from the test page');
  expect(provider.chatRequests()).toHaveLength(5);
});

test('the panel shows console problems and sends a screenshot to the message box', async () => {
  const w = graft.window;
  provider.script({ text: 'Ready.' });
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Hello');
  await composer.press('Enter');
  await expect(w.getByText('Ready.')).toBeVisible();

  await w.getByRole('button', { name: 'Browser', exact: true }).click();
  const panel = w.getByRole('region', { name: 'Browser' });
  const address = panel.getByRole('textbox', { name: 'Address' });
  await address.fill(siteUrl);
  await address.press('Enter');
  await expect(address).toHaveValue(siteUrl);

  // The page logged an error on load: the console button says so, and the drawer lists it.
  await expect(panel.getByText('1', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Console' }).click();
  await expect(panel.getByRole('region', { name: 'Console' }).getByText('boom from the test page')).toBeVisible();

  // Zoom steps show in the toolbar.
  await panel.getByRole('button', { name: 'Zoom in' }).click();
  await expect(panel.getByRole('button', { name: '110%' })).toBeVisible();

  // The screenshot is taken and handed to this session's message box, which knows the
  // scripted model can't read images (a failed capture would say so instead).
  await panel.getByRole('button', { name: 'Screenshot to chat' }).click();
  await expect(w.getByText('This model can’t read images')).toBeVisible();
  await expect(w.getByText("Couldn't take a screenshot")).toHaveCount(0);
});
