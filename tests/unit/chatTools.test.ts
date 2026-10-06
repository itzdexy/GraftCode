import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canOpen, ChatFiles, mimeOf, safeFileName } from '../../src/main/chat/chatFiles';
import { runnerScript } from '../../src/main/chat/codeSandbox';
import { sentStamp, withSentTimes } from '../../src/main/agent/history';
import { createFileTool, runCodeTool } from '../../src/main/tools/chat/chatTools';
import type { StoredMessage, ToolResultContent } from '../../src/shared/schemas/messages';
import { canOpenChatFile } from '../../src/shared/chatFileTypes';
import type { ToolContext } from '../../src/main/tools/types';
import { speechModels, synthesize } from '../../src/main/voice/speech';
import { json, startFixtureServer } from '../support/httpFixture';
import { PNG_1X1 } from '../support/pictures';
import { makeToolContext } from '../support/toolContext';
import { makeTempDir, removeDir } from '../support/tmp';

const cleanup: string[] = [];
const track = (dir: string): string => {
  cleanup.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

describe('chat files', () => {
  it('keeps files inside the chat’s folder under plain names, never replacing earlier ones', () => {
    const root = track(makeTempDir('chat files '));
    const files = new ChatFiles(root);
    const first = files.save('chat-1', 'report.md', Buffer.from('# One'));
    const second = files.save('chat-1', 'report.md', Buffer.from('# Two'));
    expect([first.name, second.name]).toEqual(['report.md', 'report (2).md']);
    expect(fs.readFileSync(first.path, 'utf8')).toBe('# One');
    expect(first.mime).toBe('text/markdown');

    const sneaky = files.save('chat-1', '../../outside\\evil.txt', Buffer.from('x'));
    expect(sneaky.name).toBe('evil.txt');
    expect(path.dirname(sneaky.path)).toBe(path.join(root, 'chat-1'));
    expect(files.find('chat-1', '../chat-1/report.md')).toBeNull();
    expect(files.find('chat-1', 'report.md')).toBe(first.path);
    expect(files.find('chat-2', 'report.md')).toBeNull();

    files.deleteForSession('chat-1');
    expect(fs.existsSync(path.join(root, 'chat-1'))).toBe(false);
  });

  it('cleans names Windows would refuse and refuses files over the size limit', () => {
    expect(safeFileName('a<b>:c?.txt')).toBe('a_b__c_.txt');
    expect(safeFileName('CON.txt')).toBe('_CON.txt');
    expect(safeFileName('  ..  ')).toBe('file.txt');
    const files = new ChatFiles(track(makeTempDir('chat files ')));
    expect(() => files.save('c', 'big.bin', Buffer.alloc(25 * 1024 * 1024 + 1))).toThrow('Files can be up to 25 MB.');
  });

  it('opens documents and pictures with a click, but never scripts or programs', () => {
    for (const name of ['notes.md', 'data.csv', 'page.html', 'logo.svg', 'photo.PNG', 'report.pdf']) expect(canOpen(name), name).toBe(true);
    for (const name of ['run.bat', 'tool.exe', 'script.js', 'app.py', 'setup.ps1', 'README']) expect(canOpen(name), name).toBe(false);
  });
});

describe('CreateFile and RunCode', () => {
  it('CreateFile tells the model everything a slide and a sheet can hold', () => {
    // A model can only use what it is told about: notes, tables, pictures and formulas.
    for (const part of ['a heading', 'a table', 'one picture', '"Note:"', '= is a formula', '![what it shows](its-file-name.png)']) {
      expect(createFileTool.description).toContain(part);
    }
  });

  it('CreateFile saves text or base64 content and shows a preview of text files', async () => {
    const dir = track(makeTempDir('chat tool '));
    const store = new ChatFiles(path.join(dir, 'files'));
    const ctx = makeToolContext(dir, { chatFiles: { save: (name, data) => store.save('chat-1', name, data) } });
    const text = await createFileTool.execute({ name: 'plan.md', content: '# Trip\n- Day 1' }, ctx);
    expect(text).toMatchObject({ isError: false, display: { kind: 'file', name: 'plan.md', mime: 'text/markdown', preview: '# Trip\n- Day 1' } });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const image = await createFileTool.execute({ name: 'dot.png', content: png.toString('base64'), encoding: 'base64' }, ctx);
    expect(image).toMatchObject({ display: { kind: 'file', name: 'dot.png', size: png.length, preview: null } });
    expect(fs.readFileSync(store.find('chat-1', 'dot.png')!)).toEqual(png);

    const outside = await createFileTool.execute({ name: 'x.txt', content: 'x' }, makeToolContext(dir));
    expect(outside.isError).toBe(true);
  });

  const saved: Array<{ name: string; data: Buffer }> = [];
  const context = (overrides: Partial<ToolContext>) =>
    makeToolContext(track(makeTempDir('chat tool ')), {
      chatFiles: { save: (name, data) => (saved.push({ name, data }), { name, path: '', size: data.length, mime: mimeOf(name) }) },
      ...overrides
    });
  const textOf = (content: ToolResultContent[]): string => content.map((c) => (c.type === 'text' ? c.text : '')).join('');

  it('builds a document from what was written, and tells the model so', async () => {
    const asked: unknown[] = [];
    const ctx = context({ makeDocument: (kind, name, source) => (asked.push([kind, name, source]), Promise.resolve(Buffer.from('%PDF-built'))) });
    const result = await createFileTool.execute({ name: 'Report.PDF', content: '# Hi' }, ctx);
    expect(asked).toEqual([['pdf', 'Report.PDF', '# Hi']]);
    expect(saved.at(-1)).toEqual({ name: 'Report.PDF', data: Buffer.from('%PDF-built') });
    expect(textOf(result.content)).toMatch(/^Created Report\.PDF \(10 B\), built from the Markdown you wrote\./);
    expect(result.display).toMatchObject({ kind: 'file', name: 'Report.PDF', preview: '# Hi' });
    expect(textOf((await createFileTool.execute({ name: 'data.xlsx', content: 'a,b' }, ctx)).content)).toContain('built from the rows you wrote');
  });

  it('saves bytes, ordinary text and a ready PDF as they are', async () => {
    const ctx = context({ makeDocument: () => Promise.reject(new Error('must not be called')) });
    for (const input of [
      { name: 'a.pdf', content: 'JVBERi0=', encoding: 'base64' as const },
      { name: 'notes.md', content: '# Notes' },
      { name: 'ready.pdf', content: '%PDF-1.4 …' }
    ]) {
      expect((await createFileTool.execute(input, ctx)).isError).toBe(false);
    }
  });

  it('never saves an office document it did not build: bytes from a model can carry what runs or calls out when opened', async () => {
    const before = saved.length;
    const ctx = context({
      makeDocument: () => Promise.resolve(Buffer.from('PK built')),
      runCode: () => Promise.resolve({ output: 'ok', error: null, timedOut: false, durationMs: 1, files: [{ name: 'macro.DOCX', data: Buffer.from('PK crafted') }, { name: 'fine.csv', data: Buffer.from('a,b') }] })
    });
    for (const name of ['evil.docx', 'evil.xlsx', 'evil.PPTX', 'evil.docx.']) {
      const refused = await createFileTool.execute({ name, content: 'UEsDBA==', encoding: 'base64' }, ctx);
      expect(refused.isError, name).toBe(true);
      expect(textOf(refused.content)).toBe('Graft builds .docx, .pptx and .xlsx files itself: give the content as Markdown (rows for a spreadsheet), not as bytes.');
    }
    expect(saved.length).toBe(before);
    // Code in the sandbox can't make one either; its other files are still saved.
    const ran = await runCodeTool.execute({ code: 'x' }, ctx);
    expect(saved.slice(before).map((f) => f.name)).toEqual(['fine.csv']);
    expect(textOf(ran.content)).toContain('Not saved: macro.DOCX: a document like this is made with CreateFile, from Markdown or rows');
    // What Graft builds is saved as before.
    expect((await createFileTool.execute({ name: 'ok.docx', content: '# Hi' }, ctx)).isError).toBe(false);
  });

  it('judges what to build by the name the file will really have', async () => {
    const asked: string[] = [];
    const ctx = context({ makeDocument: (kind) => (asked.push(kind), Promise.resolve(Buffer.from('%PDF-built'))) });
    // A trailing dot is dropped when the file is saved, so this is report.pdf and must be built, not saved as Markdown text.
    const result = await createFileTool.execute({ name: 'report.pdf.', content: '# Hi' }, ctx);
    expect(asked).toEqual(['pdf']);
    expect(textOf(result.content)).toContain('built from the Markdown you wrote');
  });

  it('says why a document could not be built, and saves nothing', async () => {
    const before = saved.length;
    const failing = context({ makeDocument: () => Promise.reject(new Error('Line 2 has a quote that is never closed.')) });
    expect(textOf((await createFileTool.execute({ name: 'data.xlsx', content: 'a,"b' }, failing)).content)).toBe("Couldn't build data.xlsx: Line 2 has a quote that is never closed.");
    expect(textOf((await createFileTool.execute({ name: 'r.pdf', content: 'x' }, context({ makeDocument: null }))).content)).toBe('Documents can be built in chats only (not in incognito chats).');
    expect(textOf((await createFileTool.execute({ name: 'r.pdf', content: 'x'.repeat(2 * 1024 * 1024 + 1) }, failing)).content)).toBe('The text of a document can be up to 2 MB.');
    expect(saved.length).toBe(before);
  });

  it('opens documents with their own app, but never the kinds that carry macros', () => {
    expect(['a.docx', 'a.xlsx', 'a.pptx', 'a.pdf'].every(canOpenChatFile)).toBe(true);
    expect(['a.docm', 'a.xlsm', 'a.pptm'].some(canOpenChatFile)).toBe(false);
    expect(mimeOf('a.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(mimeOf('a.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(mimeOf('a.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
  });

  it('reads a picture of the chat by a plain name only', () => {
    const files = new ChatFiles(track(makeTempDir('chat files ')));
    files.save('s1', 'dot.png', PNG_1X1);
    files.save('s1', 'notes.md', Buffer.from('x'));
    expect(files.image('s1', 'dot.png')).toEqual({ mime: 'image/png', data: PNG_1X1 });
    expect([files.image('s1', '../dot.png'), files.image('s1', 'notes.md'), files.image('s2', 'dot.png')]).toEqual([null, null, null]);
  });

  it('RunCode reports output and errors, and saves the files the code wrote', async () => {
    const dir = track(makeTempDir('chat tool '));
    const store = new ChatFiles(path.join(dir, 'files'));
    const ctx = makeToolContext(dir, {
      chatFiles: { save: (name, data) => store.save('chat-1', name, data) },
      runCode: (code) =>
        Promise.resolve({
          output: code.includes('fail') ? '' : '42',
          error: code.includes('fail') ? 'ReferenceError: nope is not defined' : null,
          timedOut: false,
          durationMs: 12,
          files: code.includes('fail') ? [] : [{ name: 'answer.csv', data: Buffer.from('n\n42\n') }]
        })
    });
    const ok = await runCodeTool.execute({ code: 'console.log(6 * 7)' }, ctx);
    expect(ok.isError).toBe(false);
    expect(JSON.stringify(ok.content)).toContain('42');
    expect(ok.display).toMatchObject({ kind: 'code', output: '42', error: null, files: [{ name: 'answer.csv', mime: 'text/csv' }] });
    expect(store.find('chat-1', 'answer.csv')).not.toBeNull();

    const failed = await runCodeTool.execute({ code: 'fail()' }, ctx);
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain('ReferenceError');
  });

  it('runs the code as an async function body, with the code passed as data rather than spliced into the script', () => {
    const script = runnerScript('return `})()`; // tricky');
    expect(script).toContain(JSON.stringify('return `})()`; // tricky'));
    expect(script).toContain("new AsyncFunction('graft', code)");
  });
});

describe('time stamps', () => {
  it('stamps each typed chat message with when it was sent, and leaves results and reminders alone', () => {
    const at = Date.UTC(2026, 9, 2, 19, 4);
    expect(sentStamp(at, 'UTC')).toBe('[Sent Fri, Oct 2, 2026, 7:04 PM UTC (UTC)]');
    const message = (role: 'user' | 'assistant', content: StoredMessage['content'], meta: StoredMessage['meta'] = {}): StoredMessage => ({
      id: `m${String(Math.random())}`,
      sessionId: 's',
      seq: 1,
      role,
      content,
      meta,
      createdAt: at
    });
    const stamped = withSentTimes(
      [
        message('user', [{ type: 'text', text: 'what time is it' }]),
        message('assistant', [{ type: 'text', text: 'It is 7:04 PM.' }]),
        message('user', [{ type: 'tool_result', toolUseId: 't', isError: false, content: [{ type: 'text', text: 'ok' }] }]),
        message('user', [{ type: 'text', text: 'Keep going.' }], { kind: 'reminder' })
      ],
      'UTC'
    );
    expect(stamped[0]!.content[0]).toEqual({ type: 'text', text: '[Sent Fri, Oct 2, 2026, 7:04 PM UTC (UTC)]' });
    expect(stamped[1]!.content).toHaveLength(1);
    expect(stamped[2]!.content).toHaveLength(1);
    expect(stamped[3]!.content).toHaveLength(1);
  });
});

describe('natural voices', () => {
  it('lists OpenRouter speech models that name their voices, with a price per 1,000 characters', async () => {
    const server = await startFixtureServer();
    try {
      server.route('GET', '/api/v1/models', (req, res) => {
        expect(req.path).toContain('output_modalities=speech');
        json(res, 200, {
          data: [
            { id: 'hexgrad/kokoro-82m', name: 'Kokoro 82M', supported_voices: ['af_heart', 'am_michael'], pricing: { prompt: '0.00000062', completion: '0' } },
            { id: 'google/x-tts', name: 'X TTS', supported_voices: ['Kore'], pricing: { prompt: '0.0000005', completion: '0.000006' } },
            { id: 'fish-audio/free:free', name: 'No voice list', supported_voices: null, pricing: { prompt: '0', completion: '0' } }
          ]
        });
      });
      const models = await speechModels(undefined, `${server.url}/api/v1`);
      expect(models.map((m) => m.id)).toEqual(['hexgrad/kokoro-82m', 'google/x-tts']);
      expect(models[0]).toMatchObject({ name: 'Kokoro 82M', voices: ['af_heart', 'am_michael'], billsOutput: false });
      expect(models[0]!.pricePer1kChars).toBeCloseTo(0.00062);
      expect(models[1]!.billsOutput).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('asks for MP3 speech with the key, model, voice and speed, and reports provider errors', async () => {
    const server = await startFixtureServer();
    try {
      server.route('POST', '/api/v1/audio/speech', (req, res) => {
        if (req.headers.authorization !== 'Bearer or-key') return json(res, 401, { error: { code: 401, message: 'No auth credentials found' } });
        expect(req.json()).toEqual({ model: 'hexgrad/kokoro-82m', input: 'Hello there.', voice: 'af_heart', response_format: 'mp3', speed: 1.2 });
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
      });
      const input = { text: 'Hello there.', model: 'hexgrad/kokoro-82m', voice: 'af_heart', speed: 1.2 };
      expect(await synthesize({ apiKey: 'or-key', baseUrl: `${server.url}/api/v1` }, input)).toEqual(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
      await expect(synthesize({ apiKey: 'wrong', baseUrl: `${server.url}/api/v1` }, input)).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});
