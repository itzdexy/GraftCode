# Documents from Chats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a chat, `CreateFile` builds a PDF, a text document (.docx), slides (.pptx) or a spreadsheet (.xlsx) from Markdown or rows the model wrote. Ships as 0.6.9.

**Architecture:** Converters in `src/main/chat/documents/` take text and return bytes, with no Electron in them, so Vitest runs them. The PDF goes through an HTML page and one injected `printPdf` function; `src/main/chat/pdfPrinter.ts` implements it with a hidden window that runs no script and loads nothing. `CreateFile` picks the converter by the file's extension through a new `ToolContext.makeDocument`.

**Tech Stack:** `docx` 9.8.1, `pptxgenjs` 4.0.1, `write-excel-file` 4.1.1, `mdast-util-from-markdown` 2.0.3 with `mdast-util-gfm` 3.1.0 and `micromark-extension-gfm` 3.0.0, `fflate` 0.8.3 (tests only), Electron 44 `webContents.printToPDF`, Vitest 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-next-rounds-design.md`, section 4.1. Product spec: `docs/SPEC.md`.

## Global Constraints

- Build on what is there: `CreateFile`, `ChatFiles`, the file card and their IPC keep their names and behaviour for every file that is not one of the four kinds.
- What a model writes is untrusted: it never runs as script and never makes the app load anything.
- The four kinds are decided by extension in any case; `encoding: "base64"` saves bytes as they are.
- Limits: source text 2 MB; 100 slides; 20 sheets; 100,000 rows a sheet; 60 seconds to build; pictures PNG, JPEG or GIF up to 10 MB.
- New packages only as named above, at those versions, in `devDependencies` (the main bundle then holds them).
- Copy names formats by what they are (document, slides, spreadsheet) and their extension, never by a product. Exact strings are in spec 4.1.
- Every tool input stays validated with Zod. No new IPC channel is needed.
- Tests first. Unit tests in `tests/unit/**`; renderer logic as pure functions in `tests/unit/renderer/**`.
- Interface: existing tokens and components only; every control has an accessible name.
- No commits unless the owner has asked; each task gives the message for when they do.

## Review Focus

1. Markdown holding `<script>`, an `onerror` picture or a `javascript:` link: the printed page shows it as text and nothing runs or loads (Task 1 test, Task 6 window settings).
2. CSV as spreadsheets export it: a byte-order mark first, `;` between cells, quotes with line breaks and doubled quotes inside: every cell lands where it belongs (Task 4 test).
3. A document that never finishes, or Stop pressed while it builds: the tool answers with an error within 60 seconds and the hidden window is gone (Task 5 test).
4. `REPORT.PDF`, or text that is already a PDF (`%PDF-…`) without `base64`: the extension matches in any case, and a ready PDF is saved unchanged (Task 5 test).
5. A picture named `../secret.png` or `C:\x.png`: only a plain file name of this chat is ever read (Task 1 and Task 5 tests).

---

### Task 1: Markdown to a page that is safe to print

**Files:**
- Create: `src/main/chat/documents/markdown.ts`, `src/main/chat/documents/html.ts`
- Modify: `package.json` (devDependencies)
- Test: `tests/unit/documents.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // markdown.ts
  import type { Root } from 'mdast';
  export const MAX_DOCUMENT_SOURCE = 2 * 1024 * 1024;
  export function parseMarkdown(text: string): Root;              // CommonMark plus tables, strikethrough, task items, autolinks
  export function safeHref(url: string): string | null;           // http:, https: and mailto: only
  export interface DocumentAssets { image(name: string): { mime: string; data: Buffer } | null }
  export function chatImage(url: string, assets: DocumentAssets): { mime: string; data: Buffer } | null;  // null unless url is a plain file name
  // html.ts
  export function markdownToHtml(markdown: string, options: { title: string; assets: DocumentAssets }): string;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { markdownToHtml } from '../../src/main/chat/documents/html';
import type { DocumentAssets } from '../../src/main/chat/documents/markdown';

const none: DocumentAssets = { image: () => null };

describe('a page built from Markdown', () => {
  it('keeps the structure of what was written', () => {
    const html = markdownToHtml('# Trip plan\n\nPack **light**.\n\n- socks\n- [map](https://example.com/map)\n\n| Day | City |\n| --- | --- |\n| 1 | Oslo |', { title: 'Trip plan', assets: none });
    expect(html).toContain('<title>Trip plan</title>');
    expect(html).toContain('<h1>Trip plan</h1>');
    expect(html).toContain('<strong>light</strong>');
    expect(html).toContain('<a href="https://example.com/map">map</a>');
    expect(html).toContain('<td>Oslo</td>');
  });

  it('never lets what a model wrote run or load anything', () => {
    const html = markdownToHtml('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[go](javascript:alert(1)) ![far](https://example.com/a.png)', { title: 'x', assets: none });
    expect(html).not.toMatch(/<script|<img|href="javascript:/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain(`default-src 'none'; img-src data:; style-src 'unsafe-inline'`);
    expect(html).toContain('<a href="https://example.com/a.png">far</a>');
  });

  it('places a picture of this chat by its plain file name only', () => {
    const asked: string[] = [];
    const assets: DocumentAssets = { image: (name) => (asked.push(name), name === 'chart.png' ? { mime: 'image/png', data: Buffer.from('PNG') } : null) };
    expect(markdownToHtml('![Sales](chart.png)', { title: 'x', assets })).toContain('<img src="data:image/png;base64,UE5H" alt="Sales">');
    markdownToHtml('![a](../chart.png) ![b](C:\\chart.png) ![c](sub/chart.png)', { title: 'x', assets });
    expect(asked).toEqual(['chart.png']);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/documents.test.ts`
Expected: FAIL, cannot find `src/main/chat/documents/html`.

- [ ] **Step 3: Add the parser packages and write both modules**

Add to `devDependencies`: `"mdast-util-from-markdown": "2.0.3"`, `"mdast-util-gfm": "3.1.0"`, `"micromark-extension-gfm": "3.0.0"`, then `npm install`. `parseMarkdown` is `fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })`. `markdownToHtml` walks the tree and escapes every text and attribute; an `html` node becomes its escaped text; a link whose `safeHref` is null becomes its text; an image becomes `<img>` only when `chatImage` returns data, otherwise a link (when `safeHref` allows) or its alt text. The page is `<!doctype html>` with `<meta charset="utf-8">`, the policy from the second test as a `Content-Security-Policy` meta tag, the title, and this style sheet:

```css
@page { margin: 18mm; }
body { font: 11pt/1.5 "Segoe UI", system-ui, sans-serif; color: #1f2328; }
h1 { font-size: 20pt; } h2 { font-size: 15pt; } h3 { font-size: 12.5pt; }
h1, h2, h3, h4 { line-height: 1.25; break-after: avoid; }
code, pre { font: 9.5pt/1.45 Consolas, "Cascadia Mono", monospace; }
pre { background: #f4f5f7; padding: 8pt; white-space: pre-wrap; }
table { border-collapse: collapse; } th, td { border: 0.5pt solid #999; padding: 3pt 6pt; text-align: left; }
blockquote { margin-left: 0; padding-left: 10pt; border-left: 2pt solid #bbb; color: #555; }
img { max-width: 100%; } pre, table, img { break-inside: avoid; }
a { color: #0b57d0; }
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/documents.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add package.json package-lock.json src/main/chat/documents tests/unit/documents.test.ts
git commit -m "feat(chat): turn Markdown into a page that is safe to print"
```

---

### Task 2: Text documents (.docx)

**Files:**
- Create: `src/main/chat/documents/imageSize.ts`, `src/main/chat/documents/docx.ts`, `tests/support/zip.ts`, `tests/support/pictures.ts` (exports `PNG_1X1`, the buffer in Step 1)
- Modify: `package.json` (devDependencies `docx` 9.8.1, `fflate` 0.8.3)
- Test: `tests/unit/documents.test.ts`

**Interfaces:**
- Consumes: `parseMarkdown`, `safeHref`, `chatImage`, `DocumentAssets` (Task 1).
- Produces:
  ```ts
  // imageSize.ts — PNG, JPEG and GIF headers; null for anything else
  export function imageSize(data: Buffer): { width: number; height: number } | null;
  // docx.ts
  export function markdownToDocx(markdown: string, options: { title: string; assets: DocumentAssets }): Promise<Buffer>;
  // tests/support/zip.ts
  export function zipEntries(file: Buffer): string[];
  export function zipText(file: Buffer, entry: string): string;   // throws when the entry is missing
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('the size of a picture', () => {
  it('is read from the header of a PNG, a JPEG and a GIF', () => {
    expect(imageSize(PNG_1X1)).toEqual({ width: 1, height: 1 });
    expect(imageSize(Buffer.from('GIF89a\x02\x00\x03\x00', 'latin1'))).toEqual({ width: 2, height: 3 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03]);
    expect(imageSize(jpeg)).toEqual({ width: 3, height: 2 });
    expect(imageSize(Buffer.from('not a picture'))).toBeNull();
  });
});

describe('a text document built from Markdown', () => {
  it('holds the headings, emphasis, lists, tables, links and pictures', async () => {
    const assets: DocumentAssets = { image: (name) => (name === 'dot.png' ? { mime: 'image/png', data: PNG_1X1 } : null) };
    const file = await markdownToDocx(
      '# Trip plan\n\nPack **light** and `fast`.\n\n1. Book\n2. Go\n\n| Day | City |\n| --- | --- |\n| 1 | Oslo |\n\n[map](https://example.com/map) [bad](javascript:alert(1))\n\n![Dot](dot.png)',
      { title: 'Trip plan', assets }
    );
    expect(file.subarray(0, 2).toString('latin1')).toBe('PK');
    const xml = zipText(file, 'word/document.xml');
    expect(xml).toContain('Trip plan');
    expect(xml).toMatch(/<w:b\/>[\s\S]{0,300}light/);
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('Oslo');
    expect(zipText(file, 'word/_rels/document.xml.rels')).toContain('https://example.com/map');
    expect(zipEntries(file).some((name) => name.startsWith('word/media/'))).toBe(true);
    expect(zipEntries(file).map((name) => zipText(file, name)).join('')).not.toContain('javascript:');
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/documents.test.ts`
Expected: FAIL, cannot find `imageSize` and `docx`.

- [ ] **Step 3: Write `tests/support/zip.ts`, `imageSize.ts` and `docx.ts`**

`zip.ts` wraps `unzipSync` from `fflate`. `markdownToDocx` maps the tree to `docx` objects and returns `Packer.toBuffer(document)`: headings to `HeadingLevel.HEADING_1`…`HEADING_6`; list items to paragraphs with `bullet: { level }` or a numbering reference (one `decimal` numbering config, levels 0 to 5); code to runs in Consolas; a table to `Table` with a bold first row; a safe link to `ExternalHyperlink`, any other link to its text; a chat picture to `ImageRun` at its own size, scaled down to at most 600 px wide (skipped when `imageSize` is null). The document's `title` is `options.title`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/documents.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add package.json package-lock.json src/main/chat/documents tests/support/zip.ts tests/unit/documents.test.ts
git commit -m "feat(chat): build .docx documents from Markdown"
```

---

### Task 3: Slides (.pptx)

**Files:**
- Create: `src/main/chat/documents/pptx.ts`
- Modify: `package.json` (devDependencies `pptxgenjs` 4.0.1)
- Test: `tests/unit/documents.test.ts`

**Interfaces:**
- Consumes: `parseMarkdown`, `chatImage`, `DocumentAssets` (Task 1); `imageSize` (Task 2); `zipEntries`, `zipText` (Task 2).
- Produces:
  ```ts
  export const MAX_SLIDES = 100;
  export interface Slide { title: string; bullets: Array<{ text: string; level: number }>; paragraphs: string[]; image: string | null; notes: string }
  export function splitSlides(markdown: string): Slide[];
  export function markdownToPptx(markdown: string, options: { title: string; assets: DocumentAssets }): Promise<Buffer>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const DECK = '# Launch plan\n\nSpring 2027\n\n---\n\n## Why now\n\n- Costs fell\n  - by half\n- Demand rose\n\nNote: mention the survey\n\n![Chart](dot.png)';

describe('slides built from Markdown', () => {
  it('starts a slide at each line of ---, with its first heading as the title', () => {
    expect(splitSlides(DECK)).toEqual([
      { title: 'Launch plan', bullets: [], paragraphs: ['Spring 2027'], image: null, notes: '' },
      {
        title: 'Why now',
        bullets: [{ text: 'Costs fell', level: 0 }, { text: 'by half', level: 1 }, { text: 'Demand rose', level: 0 }],
        paragraphs: [],
        image: 'dot.png',
        notes: 'mention the survey'
      }
    ]);
    expect(splitSlides('Just a line')).toEqual([{ title: 'Just a line', bullets: [], paragraphs: [], image: null, notes: '' }]);
  });

  it('writes one slide for each, with its notes and its picture', async () => {
    const assets: DocumentAssets = { image: (name) => (name === 'dot.png' ? { mime: 'image/png', data: PNG_1X1 } : null) };
    const file = await markdownToPptx(DECK, { title: 'Launch plan', assets });
    expect(zipText(file, 'ppt/slides/slide1.xml')).toContain('Launch plan');
    expect(zipText(file, 'ppt/slides/slide2.xml')).toContain('Costs fell');
    expect(zipText(file, 'ppt/notesSlides/notesSlide2.xml')).toContain('mention the survey');
    expect(zipEntries(file).some((name) => name.startsWith('ppt/media/'))).toBe(true);
  });

  it('refuses more slides than a presentation may have', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `# Slide ${String(i)}`).join('\n\n---\n\n');
    await expect(markdownToPptx(many, { title: 'x', assets: { image: () => null } })).rejects.toThrow('A presentation can have up to 100 slides.');
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/documents.test.ts`
Expected: FAIL, cannot find `pptx`.

- [ ] **Step 3: Write `pptx.ts`**

`splitSlides` splits the text on lines that are exactly `---` (outside code fences), parses each part, and reads: the first heading as `title` (or the first line of text when there is none), list items as `bullets` with their depth, a paragraph starting with `Note:` as `notes`, the first image's address as `image`, other paragraphs as `paragraphs`. `markdownToPptx` uses `new PptxGenJS()` with `layout = 'LAYOUT_WIDE'` and `title = options.title`; the first slide centres its title at 40 pt with its paragraphs at 20 pt under it; later slides put the title at 28 pt along the top and bullets at 18 pt below (`bullet: { indent }` by level), using the left half when the slide has a picture and the picture (`slide.addImage({ data })` with `data` as `image/png;base64,…`, fitted to the right half by `imageSize`) beside them; `slide.addNotes(notes)` when there are any. Text is `1F2328` on white. It returns `pptx.write({ outputType: 'nodebuffer' })` as a `Buffer`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/documents.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add package.json package-lock.json src/main/chat/documents/pptx.ts tests/unit/documents.test.ts
git commit -m "feat(chat): build .pptx slides from Markdown"
```

---

### Task 4: Spreadsheets (.xlsx)

**Files:**
- Create: `src/main/chat/documents/xlsx.ts`
- Modify: `package.json` (devDependencies `write-excel-file` 4.1.1)
- Test: `tests/unit/documents.test.ts`

**Interfaces:**
- Consumes: `zipEntries`, `zipText` (Task 2).
- Produces:
  ```ts
  export const MAX_SHEETS = 20;
  export const MAX_ROWS = 100_000;
  export type Cell = string | number | boolean | null;
  export interface Sheet { name: string; rows: Cell[][] }
  export function parseCsv(text: string): string[][];
  export function parseSheets(source: string): Sheet[];
  export function sheetsToXlsx(sheets: Sheet[]): Promise<Buffer>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe('a spreadsheet built from rows', () => {
  it('reads CSV the way spreadsheets write it', () => {
    expect(parseCsv('\uFEFFname;qty\r\n"Smith; J";3\r\n"say ""hi""\nthere";007\r\n')).toEqual([
      ['name', 'qty'],
      ['Smith; J', '3'],
      ['say "hi"\nthere', '007']
    ]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(() => parseCsv('a,b\nc,"d\ne')).toThrow('Line 2 has a quote that is never closed.');
  });

  it('types the cells: numbers, formulas, and text that only looks like a number', () => {
    expect(parseSheets('name,qty\nBolt,3\nNut,007\nRatio,-0.5\nTotal,=SUM(B2:B3)')).toEqual([
      { name: 'Sheet1', rows: [['name', 'qty'], ['Bolt', 3], ['Nut', '007'], ['Ratio', -0.5], ['Total', '=SUM(B2:B3)']] }
    ]);
  });

  it('takes several sheets as a JSON object, and refuses too many', () => {
    expect(parseSheets('{"Sales":[["Q","Amount"],["Q1",1200.5]],"Notes: 2027/Q1":[["ok",true,null]]}')).toEqual([
      { name: 'Sales', rows: [['Q', 'Amount'], ['Q1', 1200.5]] },
      { name: 'Notes 2027 Q1', rows: [['ok', true, null]] }
    ]);
    const many = JSON.stringify(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`S${String(i)}`, [[1]]])));
    expect(() => parseSheets(many)).toThrow('A spreadsheet can have up to 20 sheets.');
    const tall = JSON.stringify({ Big: Array.from({ length: 100_001 }, () => [1]) });
    expect(() => parseSheets(tall)).toThrow('Sheet "Big" has more than 100,000 rows.');
  });

  it('writes a workbook that holds them', async () => {
    const file = await sheetsToXlsx(parseSheets('{"Parts":[["name","qty"],["Bolt",3]],"More":[["x"]]}'));
    expect(zipEntries(file)).toEqual(expect.arrayContaining(['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']));
    expect(zipText(file, 'xl/workbook.xml')).toContain('Parts');
    expect(zipEntries(file).filter((n) => n.endsWith('.xml')).map((n) => zipText(file, n)).join('')).toContain('Bolt');
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/documents.test.ts`
Expected: FAIL, cannot find `xlsx`.

- [ ] **Step 3: Write `xlsx.ts`**

`parseCsv` is a character-by-character RFC 4180 reader: it drops a leading `\uFEFF`, picks `;` or a tab as the separator when the first line has more of them than commas, handles quoted cells with doubled quotes and line breaks, skips a final empty line, and counts lines for its error. `parseSheets` treats text starting with `{` as JSON (sheet name to rows, cells kept as their JSON type; anything else in a cell becomes its string form) and other text as one CSV sheet named `Sheet1`, where a cell matching `/^-?(0|[1-9]\d*)(\.\d+)?$/` becomes a number. Sheet names lose `\ / ? * [ ] :`, collapse spaces and stop at 31 characters. It throws the spec's errors for more than 20 sheets or 100,000 rows. `sheetsToXlsx` calls `writeExcelFile` from `write-excel-file/node` with one `{ data, sheet, columns }` entry a sheet and returns `.toBuffer()`: each cell is `{ value, type }` (`Number`, `Boolean`, `String`, or `'Formula'` for a string starting with `=`), the first row has `fontWeight: 'bold'`, and each column's `width` is its longest cell, between 8 and 60.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/documents.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add package.json package-lock.json src/main/chat/documents/xlsx.ts tests/unit/documents.test.ts
git commit -m "feat(chat): build .xlsx spreadsheets from CSV or JSON rows"
```

---

### Task 5: `CreateFile` builds documents

**Files:**
- Create: `src/main/chat/documents/index.ts`
- Modify: `src/main/tools/types.ts` (ToolContext), `src/main/tools/chat/chatTools.ts`, `src/main/chat/chatFiles.ts`, `src/shared/chatFileTypes.ts`, `src/main/agent/session.ts` (`SessionDeps`, `toolContext`), `src/main/agent/sessionManager.ts` (`SessionManagerDeps`, pass-through), `src/main/agent/systemPrompt.ts` (chat paragraph), `tests/support/toolContext.ts`, `tests/support/sessionHarness.ts`
- Test: `tests/unit/documents.test.ts`, `tests/unit/chatTools.test.ts`, `tests/unit/agent.test.ts`

**Interfaces:**
- Consumes: `markdownToHtml` (Task 1), `markdownToDocx` (Task 2), `markdownToPptx` (Task 3), `parseSheets`, `sheetsToXlsx` (Task 4), `MAX_DOCUMENT_SOURCE`, `DocumentAssets` (Task 1).
- Produces:
  ```ts
  // documents/index.ts
  export type DocumentKind = 'pdf' | 'docx' | 'pptx' | 'xlsx';
  export const DOCUMENT_TIMEOUT_MS = 60_000;
  export function documentKind(name: string): DocumentKind | null;
  export function pageSizeFor(country: string): 'Letter' | 'A4';
  export class DocumentMaker {
    constructor(deps: { printPdf(html: string, signal: AbortSignal): Promise<Buffer> });
    make(kind: DocumentKind, source: string, options: { title: string; assets: DocumentAssets }, signal: AbortSignal): Promise<Buffer>;
  }
  // ToolContext
  makeDocument: ((kind: DocumentKind, name: string, source: string, signal: AbortSignal) => Promise<Buffer>) | null;
  // ChatFiles
  image(sessionId: string, name: string): { mime: string; data: Buffer } | null;
  // SessionDeps and SessionManagerDeps
  documents: DocumentMaker | null;
  ```

- [ ] **Step 1: Write the failing tests**

In `tests/unit/documents.test.ts`:

```ts
describe('making a document', () => {
  const options = { title: 'Report', assets: { image: () => null } };
  const never = new AbortController().signal;

  it('knows the four kinds by their extension, in any case', () => {
    expect(['a.pdf', 'A.PDF', 'b.docx', 'c.Pptx', 'd.xlsx', 'e.md', 'f.docm', 'pdf'].map(documentKind)).toEqual(['pdf', 'pdf', 'docx', 'pptx', 'xlsx', null, null, null]);
    expect(['US', 'CA', 'MX', 'NO', ''].map(pageSizeFor)).toEqual(['Letter', 'Letter', 'Letter', 'A4', 'A4']);
  });

  it('prints a PDF from the page it built', async () => {
    let page = '';
    const maker = new DocumentMaker({ printPdf: (html) => ((page = html), Promise.resolve(Buffer.from('%PDF-1.7'))) });
    expect((await maker.make('pdf', '# Report', options, never)).toString()).toBe('%PDF-1.7');
    expect(page).toContain('<h1>Report</h1>');
    expect((await maker.make('xlsx', 'a,b\n1,2', options, never)).subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('gives up after a minute, and at once when the turn is stopped', async () => {
    vi.useFakeTimers();
    const stuck = new DocumentMaker({ printPdf: () => new Promise<Buffer>(() => undefined) });
    const late = expect(stuck.make('pdf', 'x', options, never)).rejects.toThrow('Building the document took longer than 60 seconds.');
    await vi.advanceTimersByTimeAsync(60_000);
    await late;
    vi.useRealTimers();
    const stop = new AbortController();
    const stopped = expect(stuck.make('pdf', 'x', options, stop.signal)).rejects.toThrow('Stopped.');
    stop.abort();
    await stopped;
  });
});
```

In `tests/unit/chatTools.test.ts`, inside `describe('CreateFile and RunCode')`, with these helpers above the tests:

```ts
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
  ]) expect((await createFileTool.execute(input, ctx)).isError).toBe(false);
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
  const files = new ChatFiles(makeTempDir());
  files.save('s1', 'dot.png', PNG_1X1);
  files.save('s1', 'notes.md', Buffer.from('x'));
  expect(files.image('s1', 'dot.png')).toEqual({ mime: 'image/png', data: PNG_1X1 });
  expect([files.image('s1', '../dot.png'), files.image('s1', 'notes.md'), files.image('s2', 'dot.png')]).toEqual([null, null, null]);
});
```

In `tests/unit/agent.test.ts`, with the chat harness:

```ts
it('a chat builds a document through the session, and its prompt says how', async () => {
  const files = new ChatFiles(makeTempDir());
  const h = harness({
    kind: 'chat',
    chatFiles: files,
    documents: new DocumentMaker({ printPdf: () => Promise.resolve(Buffer.from('%PDF-from-session')) }),
    script: [{ toolCalls: [{ name: 'CreateFile', input: { name: 'report.pdf', content: '# Report' } }] }, { text: 'Done.' }]
  });
  h.session.send('make a report');
  await h.session.idle();
  expect(fs.readFileSync(files.find('session-1', 'report.pdf')!, 'utf8')).toBe('%PDF-from-session');
  expect(h.provider.requests[0]!.system).toContain('write Markdown and name the file .pdf or .docx');
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/unit/documents.test.ts tests/unit/chatTools.test.ts tests/unit/agent.test.ts`
Expected: FAIL (`documentKind`, `makeDocument`, `ChatFiles.image` and the harness option do not exist).

- [ ] **Step 3: Write `documents/index.ts`, then wire it through**

`DocumentMaker.make` races the conversion against `DOCUMENT_TIMEOUT_MS` and the signal (errors `Building the document took longer than 60 seconds.` and `Stopped.`), passing its own `AbortSignal` to `printPdf` so the printer can close its window. In `createFileTool.execute`: `kind = encoding === 'base64' ? null : documentKind(name)`; a `pdf` whose content starts with `%PDF-` is saved as it is; otherwise check `MAX_DOCUMENT_SOURCE`, call `ctx.makeDocument(kind, name, content, ctx.signal)`, save the bytes, and use the result text and errors of spec 4.1 (`rows` for `xlsx`, `Markdown` for the rest; the card's `preview` is the first 4,000 characters of the source). Raise the tool's `timeoutMs` to 75,000 and replace its description with spec 4.1's. `ChatFiles.image` returns a file of that chat whose `mimeOf` is `image/png`, `image/jpeg` or `image/gif` and whose size is at most 10 MB. The session's `toolContext` sets `makeDocument` when `work.files`, `deps.documents` and `deps.chatFiles` are all there, with `title` = the name without its extension and `assets.image` = `chatFiles.image(this.id, name)`. Add the three MIME types to `chatFiles.ts`, the three extensions to `OPENABLE`, the harness option `documents`, `makeDocument: null` to `makeToolContext`, and replace the chat prompt's `CreateFile` paragraph with spec 4.1's.

- [ ] **Step 4: Run the tests, then the type check**

Run: `npx vitest run tests/unit/documents.test.ts tests/unit/chatTools.test.ts tests/unit/agent.test.ts && npx tsc -p tsconfig.node.json --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src/main src/shared/chatFileTypes.ts tests
git commit -m "feat(chat): CreateFile builds PDFs, documents, slides and spreadsheets"
```

---

### Task 6: The printer, the card and the real app

**Files:**
- Create: `src/main/chat/pdfPrinter.ts`, `src/renderer/src/features/session/fileCardModel.ts`, `scripts/e2e-docker.mjs`
- Modify: `src/main/index.ts` (next to `runCode: runInSandbox`), `src/renderer/src/features/session/FilesCard.tsx`, `package.json` (script `test:e2e:docker`), `README.md` (script table)
- Test: `tests/unit/renderer/rendererLogic.test.ts`, `tests/e2e/chat.spec.ts`

**Interfaces:**
- Consumes: `DocumentMaker`, `pageSizeFor` (Task 5).
- Produces:
  ```ts
  // pdfPrinter.ts — Electron only
  export function printHtmlToPdf(html: string, signal: AbortSignal): Promise<Buffer>;
  // fileCardModel.ts
  export type FileGlyph = 'image' | 'sheet' | 'slides' | 'web' | 'code' | 'document' | 'text';
  export function fileGlyph(file: { name: string; mime: string }): FileGlyph;
  ```

- [ ] **Step 1: Write the failing tests**

In `tests/unit/renderer/rendererLogic.test.ts`, inside `describe('formatting')`:

```ts
it('gives each kind of file its own icon', () => {
  const glyph = (name: string, mime: string) => fileGlyph({ name, mime });
  expect(glyph('r.pdf', 'application/pdf')).toBe('document');
  expect(glyph('r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('document');
  expect(glyph('d.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('sheet');
  expect(glyph('d.csv', 'text/csv')).toBe('sheet');
  expect(glyph('s.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('slides');
  expect(glyph('p.png', 'image/png')).toBe('image');
  expect(glyph('i.html', 'text/html')).toBe('web');
  expect(glyph('m.ts', 'text/plain')).toBe('code');
  expect(glyph('n.md', 'text/markdown')).toBe('text');
});
```

In `tests/e2e/chat.spec.ts`:

```ts
test('a chat builds a PDF, a document, slides and a spreadsheet from what the model wrote', async () => {
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
  const pdf = await save('report.pdf');
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(1000);
  for (const [name, entry] of [['report.docx', 'word/document.xml'], ['deck.pptx', 'ppt/slides/slide2.xml'], ['data.xlsx', 'xl/worksheets/sheet1.xml']] as const) {
    const file = await save(name);
    expect(file.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(file.includes(entry)).toBe(true);
    await expect(card.getByRole('button', { name: `Open ${name}` })).toBeVisible();
  }
  expect(JSON.stringify(provider.chatRequests()[1]!.body)).toContain('built from the Markdown you wrote');
});
```

- [ ] **Step 2: Run the unit test and see it fail**

Run: `npx vitest run tests/unit/renderer/rendererLogic.test.ts`
Expected: FAIL, cannot find `fileCardModel`.

- [ ] **Step 3: Write `fileCardModel.ts`, use it in `FilesCard.tsx`, and write `pdfPrinter.ts`**

`FilesCard`'s `iconFor` becomes a lookup from `fileGlyph` to lucide icons (`Presentation` for `slides`; the others as today). `printHtmlToPdf` follows `src/main/chat/codeSandbox.ts`: a session from `session.fromPartition('graft-documents', { cache: false })` whose `protocol.handle('graft-doc', …)` serves the page being printed (looked up by a random id, with the policy as a `content-security-policy` header too) and whose `webRequest.onBeforeRequest` cancels every address that does not start with `graft-doc:` or `data:`; permission handlers that refuse; a `BrowserWindow` with `show: false`, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `javascript: false`, `devTools: false`, `setWindowOpenHandler` denying and `will-navigate` prevented. It loads `graft-doc://print/<id>`, then calls `printToPDF({ pageSize: pageSizeFor(app.getLocaleCountryCode()), printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="width:100%;font-size:8px;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>', generateDocumentOutline: true, generateTaggedPDF: true })`. Prints go one at a time; the window is destroyed in a `finally`, and on the signal's `abort`. In `src/main/index.ts` pass `documents: new DocumentMaker({ printPdf: printHtmlToPdf })` where `runCode: runInSandbox` is passed.

- [ ] **Step 4: Add the container script, then run the unit tests, the build and the chat suite**

Write `scripts/e2e-docker.mjs` as spec section 6 describes it, add `"test:e2e:docker": "node scripts/e2e-docker.mjs"` to `package.json`, and a row to the README's script table: `Runs the end-to-end tests in a Linux container, from the working tree (needs Docker)`.

Run: `npx vitest run tests/unit/renderer/rendererLogic.test.ts && npm run build`
Expected: PASS; the build ends with `✓ built`.
Run: `docker desktop start`, then `npm run test:e2e:docker -- tests/e2e/chat.spec.ts`
Expected: every test in the file passes, including the new one. The `<script>` in the report proves nothing by itself; the settings in Step 3 are what keep it from running, so read them once more against spec 4.1.

- [ ] **Step 5: Commit (only when the owner has asked for commits)**

```bash
git add src/main/chat/pdfPrinter.ts src/main/index.ts src/renderer/src/features/session scripts/e2e-docker.mjs package.json README.md tests
git commit -m "feat(chat): print PDFs in a window that runs nothing, and show document icons"
```

---

### Task 7: Release 0.6.9

**Files:**
- Modify: `package.json` (`version`), `package-lock.json` (two root `version` entries), `src/renderer/src/features/home/releaseNotes.json`, `README.md`, `docs/PRODUCT_ROADMAP.md`, `resources/catalog/models.json` (by `npm run catalog`)

- [ ] **Step 1: Refresh the model list and bump the version**

Run: `npm run catalog`
Then set `0.6.9` in `package.json` and both root entries of `package-lock.json`.

- [ ] **Step 2: Write the notes**

Add at the top of `releaseNotes.json`, dated the day of release:

```json
{
  "version": "0.6.9",
  "date": "YYYY-MM-DD",
  "items": [
    "Chats make real documents. Ask for a PDF, a text document (.docx), slides (.pptx) or a spreadsheet (.xlsx) and Graft builds it from what the model writes, with headings, lists, tables, links and the pictures made in that chat. Each one appears as a card to save, open or show in its folder.",
    "A document is built inside Graft, in a window that runs no script and loads nothing from the web. Spreadsheets take numbers and formulas; slides take a title, bullets, a picture and speaker's notes."
  ]
}
```

In `README.md`, extend "Files to download" under Chats with the four kinds. In `docs/PRODUCT_ROADMAP.md`, add a `### 0.6.9` section under Completed that names the files of this plan, and note under weaknesses that documents are made in chats only and that web PDFs still can't be read.

- [ ] **Step 3: Verify the whole round**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: no errors; every unit test passes.
Run: `docker desktop start`, then `npm run test:e2e:docker`, then `docker desktop stop`
Expected: `0 failed`. Report the exact counts.

- [ ] **Step 4: Commit (only when the owner has asked for commits)**

```bash
git add -A
git commit -m "chore: 0.6.9 notes and README"
```
