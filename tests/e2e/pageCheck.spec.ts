import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { launchGraft, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding, makeGitProject } from './support/onboard';

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

/**
 * A page with one of each thing the check looks for, and nothing else wrong:
 * faint text twice in one pair of colours, dim text on a dark card, text over
 * a gradient (which cannot be judged), a picture without alt beside one that
 * is marked as decoration, a button without a name, two small buttons that
 * touch, a field with only a placeholder, a heading that skips a level, no
 * language, and a box that is wider than a phone but fits a desktop.
 */
const PAGE = `<!doctype html>
<html>
<head>
<title>Flawed page</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; font: 16px/1.5 sans-serif; background: #fff; color: #111; }
  section { margin: 32px 16px; }
  .faint { color: #999; }
  .card { background: #222; color: #eee; padding: 8px; }
  .card .dim { color: #555; }
  .hero { background: linear-gradient(#036, #069); color: #fff; padding: 8px; }
  .wide { width: 900px; height: 24px; background: #ccd; }
  .x { width: 16px; height: 16px; padding: 0; border: 0; margin: 0; vertical-align: top; }
  @media (min-width: 1000px) { .wide { width: 100px; } }
</style>
</head>
<body>
<section><h1>Flawed page</h1><h3>Skipped a level</h3></section>
<section><p class="faint">Faint words</p><p class="faint">More faint words</p></section>
<section class="card"><span class="dim">Dim on dark</span> <span>Fine on dark</span></section>
<section class="hero">Over a gradient</section>
<section><img src="${PIXEL}" width="40" height="40"> <img alt="" src="${PIXEL}" width="40" height="40"></section>
<section><button class="x"></button><button class="x" aria-label="Close"></button></section>
<section><button id="order">Order now</button></section>
<section><input id="email" placeholder="Email"></section>
<section><label>Name <input id="name"></label></section>
<section><p>Read the <a href="#terms">terms</a> first.</p></section>
<div class="wide">wide box</div>
</body>
</html>`;

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

/** The text the model was sent back for the tool call before request `index`. */
function toolResultBefore(index: number): string {
  const messages = (provider.chatRequests()[index]!.body as { messages: Array<{ content: unknown }> }).messages;
  const content = messages[messages.length - 1]!.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/** Asks the main process as the window does. */
async function ask<T>(channel: string, input?: unknown): Promise<T> {
  const result = await graft.window.evaluate(([c, i]) => (window as unknown as { graft: { invoke(channel: string, input: unknown): Promise<unknown> } }).graft.invoke(c as string, i), [channel, input]);
  const answer = result as { ok: true; value: T } | { ok: false; error: { message: string } };
  if (!answer.ok) throw new Error(answer.error.message);
  return answer.value;
}

/** The page views laid over the window: where each is, and how wide its page is laid out. */
function pageViews(): Promise<Array<{ width: number; height: number; laidOut: number }>> {
  return graft.app.evaluate(({ BrowserWindow }) => {
    const views = BrowserWindow.getAllWindows()[0]!.contentView.children as unknown as Array<{ getBounds(): { width: number; height: number }; webContents: { executeJavaScript(code: string): Promise<number> } }>;
    return Promise.all(views.map(async (view) => ({ ...view.getBounds(), laidOut: await view.webContents.executeJavaScript('innerWidth') })));
  });
}

function pngSize(base64: string): [number, number] {
  const png = Buffer.from(base64, 'base64');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

test('the agent checks a page as a desktop and as a phone lay it out', async () => {
  const w = graft.window;
  provider.script(
    { toolCalls: [{ name: 'Browser', input: { action: 'open', url: siteUrl } }] },
    { toolCalls: [{ name: 'Browser', input: { action: 'check', width: 1280 } }] },
    { toolCalls: [{ name: 'Browser', input: { action: 'check', width: 390 } }] },
    { text: 'The page has problems.' }
  );
  const composer = w.getByRole('textbox', { name: 'Describe a task or ask a question' });
  await composer.fill('Check the page');
  await composer.press('Enter');
  // Opening a page asks first in Ask mode; looking at it afterwards doesn't.
  await w.getByRole('alertdialog', { name: /^Open http:\/\/127\.0\.0\.1:\d+\/ in the browser$/ }).getByRole('button', { name: /Allow once/ }).click();
  await expect(w.getByText('The page has problems.')).toBeVisible({ timeout: 30_000 });
  // The steps are one folded line; unfolded, each check is named.
  await w.getByText(/^Tested 127\.0\.0\.1:\d+ in the browser/).click();
  await expect(w.getByText('Checked the page')).toHaveCount(2);

  const desktop = toolResultBefore(2);
  expect(desktop).toContain(`Checked Flawed page (${siteUrl}) at 1280 px wide: 4 problems, 5 warnings.`);
  // Faint text is one finding for its pair of colours; the dim text on the card is judged against the card.
  expect(desktop).toContain('- Contrast 2.84:1 where 4.5:1 is needed: #999999 on #ffffff, in 2 places. At body > section:nth-of-type(2) > p.faint:nth-of-type(1) ("Faint words")');
  expect(desktop).toContain('- Contrast 2.13:1 where 4.5:1 is needed: #555555 on #222222. At body > section.card:nth-of-type(3) > span.dim:nth-of-type(1) ("Dim on dark")');
  expect(desktop).toContain('- A button with no name: a screen reader says only "button". At body > section:nth-of-type(6) > button.x:nth-of-type(1)');
  expect(desktop).toContain('- A picture with no alt text. At body > section:nth-of-type(5) > img:nth-of-type(1) ("inline picture")');
  expect(desktop).toContain('- A field named only by its placeholder, which is gone once someone types. At #email ("Email")');
  expect(desktop).toContain('- Heading levels jump from h1 to h3. At body > section:nth-of-type(1) > h3 ("Skipped a level")');
  // The two small buttons touch: both are named. The unstyled button, the fields and the link in the sentence are not.
  expect(desktop.match(/px target with another one within 24 px of it/g)).toHaveLength(2);
  expect(desktop).toContain('- The page does not say which language it is in (no lang on <html>).');
  expect(desktop).toContain('Contrast was not judged for 1 text over a picture or a gradient.');
  // A desktop is wide enough for the box.
  expect(desktop).not.toContain('scrolls sideways');

  const phone = toolResultBefore(3);
  expect(phone).toContain(`Checked Flawed page (${siteUrl}) at 390 px wide: 6 problems, 5 warnings.`);
  expect(phone).toContain('- The page is 510 px wider than its 390 px window, so it scrolls sideways.');
  expect(phone).toContain('- Runs 510 px past the right edge. At body > div.wide ("wide box")');

  // Afterwards the page is in the panel again, laid out as wide as the panel shows it.
  const views = await pageViews();
  expect(views).toHaveLength(1);
  expect(views[0]!.width).toBeGreaterThan(200);
  expect(views[0]!.width).toBeLessThan(1000);
  expect(views[0]!.laidOut).toBe(views[0]!.width);
});

test('the page is pictured at three sizes whatever size the panel is, and is as it was afterwards', async () => {
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
  await expect(panel.getByRole('progressbar', { name: 'Loading' })).toHaveCount(0);

  const shots = await ask<Array<{ id: string; label: string; image: { mediaType: string; data: string } }>>('browser:captureSizes');
  expect(shots.map((shot) => [shot.id, shot.label, shot.image.mediaType, ...pngSize(shot.image.data)])).toEqual([
    ['phone', 'Phone (390 px)', 'image/png', 390, 844],
    ['tablet', 'Tablet (768 px)', 'image/png', 768, 1024],
    ['desktop', 'Desktop (1280 px)', 'image/png', 1280, 800]
  ]);

  // The panel has its own width back: narrower than a desktop, so the wide box sticks out again.
  const asShown = await ask<{ width: number; findings: Array<{ rule: string; selector: string }> }>('browser:check');
  expect(asShown.width).toBeLessThan(1000);
  expect(asShown.findings.filter((finding) => finding.rule === 'overflow').map((finding) => finding.selector)).toEqual(['', 'body > div.wide']);

  // What a finding points at can be shown in the page; a selector that finds nothing says so.
  expect(await ask<boolean>('browser:highlight', { selector: 'body > div.wide' })).toBe(true);
  expect(await ask<boolean>('browser:highlight', { selector: 'div.nowhere' })).toBe(false);

  // With the page out of the window (as it is while a menu or a dialog is open), it is still pictured.
  await ask('browser:bounds', { bounds: null });
  const hidden = await ask<Array<{ image: { data: string } }>>('browser:captureSizes');
  expect(hidden.map((shot) => pngSize(shot.image.data))).toEqual([[390, 844], [768, 1024], [1280, 800]]);
});

test('the panel lists what is wrong with the page, shows a finding in it and writes the request to fix it', async () => {
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

  // The check opens a drawer under the page. The panel is narrower than the wide box, so that is found too.
  await panel.getByRole('button', { name: 'Check the page' }).click();
  const drawer = panel.getByRole('region', { name: 'Page check' });
  await expect(drawer.getByRole('status')).toHaveText(/^6 problems, 5 warnings at \d+ px wide$/);
  await expect(drawer.getByRole('button', { name: /^Problem: A picture with no alt text\. At / })).toBeVisible();
  await expect(drawer.getByRole('button', { name: /^Warning: Heading levels jump from h1 to h3\. At / })).toBeVisible();
  await expect(drawer.getByText('The page does not say which language it is in (no lang on <html>).')).toBeVisible();
  await expect(drawer.getByText(/Looked at 12 texts, 2 pictures, 6 controls and 2 headings\. Contrast was not judged for 1 text/)).toBeVisible();
  // The button counts the problems of the page that is shown.
  await expect(panel.getByRole('button', { name: 'Check the page' }).locator('..').getByText('6', { exact: true })).toBeVisible();

  await w.screenshot({ path: test.info().outputPath('page-check.png') });

  // A finding is shown in the page: a box is drawn around what it is about.
  const marked = (): Promise<boolean> =>
    graft.app.evaluate(({ BrowserWindow }) => {
      const views = BrowserWindow.getAllWindows()[0]!.contentView.children as unknown as Array<{ webContents: { executeJavaScript(code: string): Promise<boolean> } }>;
      return views[0]!.webContents.executeJavaScript('[...document.documentElement.children].some((el) => el.tagName === "DIV" && el.style.zIndex === "2147483647")');
    });
  expect(await marked()).toBe(false);
  await drawer.getByRole('button', { name: /^Problem: Runs \d+ px past the right edge\. At body > div\.wide/ }).click();
  await expect.poll(marked).toBe(true);

  // Checking again lists the same page the same way.
  await drawer.getByRole('button', { name: 'Check again' }).click();
  await expect(drawer.getByRole('status')).toHaveText(/^6 problems, 5 warnings at \d+ px wide$/);

  // The request to fix it is written into the message box, and is not sent.
  await drawer.getByRole('button', { name: 'Ask Graft to fix these' }).click();
  const box = w.getByRole('textbox', { name: /^Ask anything/ });
  await expect(box).toHaveValue(/^Fix what the page check found on http:\/\/127\.0\.0\.1:\d+\/ \(laid out \d+ px wide\):\n- The page is \d+ px wider than its \d+ px window, so it scrolls sideways\.\n/);
  await expect(box).toHaveValue(/- A button with no name: a screen reader says only "button"\. At body > section:nth-of-type\(6\) > button\.x:nth-of-type\(1\)\n/);
  expect(provider.chatRequests()).toHaveLength(1);

  // The console and the check share the space under the page: one at a time.
  await panel.getByRole('button', { name: 'Console' }).click();
  await expect(panel.getByRole('region', { name: 'Console' })).toBeVisible();
  await expect(drawer).toHaveCount(0);

  // Three sizes go to the message box in one press (the scripted model can't read pictures, and the box says so).
  await panel.getByRole('button', { name: 'Screenshot at phone, tablet and desktop size' }).click();
  await expect(w.getByText('This model can’t read images')).toBeVisible();
  await expect(w.getByText("Couldn't take the screenshots")).toHaveCount(0);
});
