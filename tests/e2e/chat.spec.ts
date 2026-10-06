import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchGraft, makeTempDir, type LaunchedApp } from './support/launch';
import { MockProvider } from './support/mockProvider';
import { completeOnboarding } from './support/onboard';

let provider: MockProvider;
let graft: LaunchedApp;

test.afterEach(async () => {
  await graft.close();
  await provider.close();
});

test('a chat runs code in the sandbox and makes files to download', async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider);
  await w.getByRole('radio', { name: 'Chat' }).click();

  provider.script(
    { toolCalls: [{ name: 'RunCode', input: { code: 'const n = 6 * 7;\nconsole.log("answer", n);\ngraft.writeFile("answer.csv", "n\\n" + n + "\\n");' } }] },
    { toolCalls: [{ name: 'CreateFile', input: { name: 'notes.md', content: '# Notes\n\nForty-two.' } }] },
    { text: 'Here are your files.' }
  );
  const composer = w.getByRole('textbox', { name: 'How can I help you today?' });
  await composer.fill('Work out 6 times 7 and give me the files');
  await composer.press('Enter');
  await expect(w.getByText('Here are your files.')).toBeVisible();

  // The code really ran in the sandbox: its output went back to the model.
  const afterRun = JSON.stringify((provider.chatRequests()[1]!.body as { messages: unknown[] }).messages.slice(-1));
  expect(afterRun).toContain('answer 42');
  // Each message tells the model when it was sent.
  expect(JSON.stringify(provider.chatRequests()[0]!.body)).toMatch(/\[Sent /);

  const card = w.getByRole('region', { name: 'Files from this reply' });
  await expect(card.getByText('answer.csv')).toBeVisible();
  await expect(card.getByText('notes.md')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Open notes.md' })).toBeVisible();

  // Save a copy where the user chooses.
  const target = path.join(makeTempDir('graft-e2e-save-'), 'my-notes.md');
  await graft.app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: chosen });
  }, target);
  await card.getByRole('button', { name: 'Save notes.md' }).click();
  await expect.poll(() => fs.existsSync(target)).toBe(true);
  expect(fs.readFileSync(target, 'utf8')).toBe('# Notes\n\nForty-two.');
});

test('a chat builds a PDF, a document, slides and a spreadsheet from what the model wrote', async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider);
  await w.getByRole('radio', { name: 'Chat' }).click();

  provider.script(
    {
      toolCalls: [
        { name: 'CreateFile', input: { name: 'report.pdf', content: '# Report\n\nForty-two **exactly**.\n\n<script>document.title = "ran"</script>\n\n| n | sq |\n| - | - |\n| 6 | 36 |' } },
        { name: 'CreateFile', input: { name: 'report.docx', content: '# Report\n\nForty-two.' } },
        { name: 'CreateFile', input: { name: 'deck.pptx', content: '# Deck\n\n---\n\n## One\n\n- a' } },
        { name: 'CreateFile', input: { name: 'data.xlsx', content: 'n,sq\n6,36' } }
      ]
    },
    { text: 'Four files.' }
  );
  const composer = w.getByRole('textbox', { name: 'How can I help you today?' });
  await composer.fill('Make the report in every format');
  await composer.press('Enter');
  await expect(w.getByText('Four files.')).toBeVisible();

  const card = w.getByRole('region', { name: 'Files from this reply' });
  const dir = makeTempDir('graft-e2e-docs-');
  const save = async (name: string): Promise<Buffer> => {
    const target = path.join(dir, name);
    await graft.app.evaluate(({ dialog }, chosen) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: chosen });
    }, target);
    await card.getByRole('button', { name: `Save ${name}` }).click();
    await expect.poll(() => fs.existsSync(target)).toBe(true);
    return fs.readFileSync(target);
  };

  // The PDF was really printed, not written as text.
  const pdf = await save('report.pdf');
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(1000);
  await expect(card.getByRole('button', { name: 'Open report.pdf' })).toBeVisible();

  // The other three are real packages holding the part each format needs.
  for (const [name, entry] of [
    ['report.docx', 'word/document.xml'],
    ['deck.pptx', 'ppt/slides/slide2.xml'],
    ['data.xlsx', 'xl/worksheets/sheet1.xml']
  ] as const) {
    const file = await save(name);
    expect(file.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(file.includes(entry)).toBe(true);
    await expect(card.getByRole('button', { name: `Open ${name}` })).toBeVisible();
  }

  // The model was told what it got back.
  expect(JSON.stringify(provider.chatRequests()[1]!.body)).toContain('built from the Markdown you wrote');
});

test('/research sends the routine; a cited page that was opened says so, and one that was not is flagged', async () => {
  provider = await MockProvider.start();
  graft = await launchGraft();
  const w = graft.window;
  await completeOnboarding(graft, provider);
  await w.getByRole('radio', { name: 'Chat' }).click();

  // The page that is read is served from this computer and asked for by name, as a dev server would be.
  const pages = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Heat pumps in the cold</title></head><body><p>They keep working down to -25 C.</p></body></html>');
  });
  await new Promise<void>((resolve) => pages.listen(0, 'localhost', resolve));
  try {
    const host = 'localhost';
    const page = `http://${host}:${String((pages.address() as AddressInfo).port)}/study`;
    provider.script(
      { toolCalls: [{ name: 'WebFetch', input: { url: page } }] },
      { text: `They work down to -25 C [${host}](${page}). Others say more [example.com](https://example.com/never-opened).` }
    );
    const composer = w.getByRole('textbox', { name: 'How can I help you today?' });
    await composer.fill('/research how heat pumps work in cold climates');
    await composer.press('Enter');

    // A chat reads the web without asking, but not this computer: that takes a yes.
    const card = w.getByRole('alertdialog');
    await expect(card).toBeVisible();
    await expect(card.getByText('Reads from this computer or your local network.')).toBeVisible();
    await card.getByRole('button', { name: /Allow once/ }).click();

    await expect(w.getByText('They work down to -25 C')).toBeVisible();
    const first = JSON.stringify(provider.chatRequests()[0]!.body);
    expect(first).toContain('Work like a careful researcher');
    expect(first).toContain('how heat pumps work in cold climates');
    // What the user typed is what the transcript shows, not the routine.
    await expect(w.getByText('/research how heat pumps work in cold climates')).toBeVisible();
    // The page really was read, whichever of this computer's two addresses the server listens on.
    expect(JSON.stringify((provider.chatRequests()[1]!.body as { messages: unknown[] }).messages.slice(-1))).toContain('They keep working down to -25 C.');

    const sources = w.getByRole('region', { name: 'Sources of this reply' });
    await expect(sources.getByText('Read 1 page')).toBeVisible();
    await expect(sources.getByText('Heat pumps in the cold')).toBeVisible();
    await expect(w.getByRole('link', { name: `${host}: Opened in this conversation` })).toBeVisible();
    await expect(w.getByRole('link', { name: 'example.com: Not opened or found in this conversation' })).toBeVisible();
  } finally {
    pages.close();
  }
});
