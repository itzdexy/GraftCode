import path from 'node:path';
import type { DocumentAssets } from './markdown';

/**
 * The documents a chat can build from what a model wrote: a PDF, a text
 * document, slides or a spreadsheet, by the file's extension. The converters
 * and their libraries are loaded only when a document is built, so they cost
 * nothing at startup.
 */

export type DocumentKind = 'pdf' | 'docx' | 'pptx' | 'xlsx';

/** Characters of Markdown or rows a document may be built from. */
export const MAX_DOCUMENT_SOURCE = 2 * 1024 * 1024;
export const DOCUMENT_TIMEOUT_MS = 60_000;

const KINDS: Record<string, DocumentKind> = { '.pdf': 'pdf', '.docx': 'docx', '.pptx': 'pptx', '.xlsx': 'xlsx' };

/** The kind of document a file name asks for, whatever the case of its extension; null for any other file. */
export function documentKind(name: string): DocumentKind | null {
  return KINDS[path.extname(name).toLowerCase()] ?? null;
}

/** US Letter where it is the paper people have (the US, Canada, Mexico), A4 everywhere else. */
export function pageSizeFor(country: string): 'Letter' | 'A4' {
  return ['US', 'CA', 'MX'].includes(country.toUpperCase()) ? 'Letter' : 'A4';
}

/** The bytes of pictures one document may place. */
export const MAX_PICTURE_BYTES = 40 * 1024 * 1024;

/**
 * The chat's pictures as one document may use them.
 *
 * A name that is no picture of the chat is refused, so the model hears about
 * it and can put it right; left out quietly, the user would get a document
 * with a figure missing and be told it was done. Only a plain file name gets
 * this far (see chatImage): a picture on the web is never fetched and becomes
 * a link, which is no mistake.
 *
 * The pictures of one document have a budget. A picture placed twice counts
 * twice, since it is embedded twice: without this, one line repeated in what
 * a model wrote could ask for more memory than the computer has.
 */
function checked(assets: DocumentAssets): DocumentAssets {
  let left = MAX_PICTURE_BYTES;
  return {
    image(name) {
      const found = assets.image(name);
      if (!found) throw new Error(`There is no picture named ${name} in this chat. A document can place a .png, .jpg or .gif made in this chat, up to 10 MB.`);
      if ((left -= found.data.length) < 0) throw new Error(`The pictures in a document can add up to ${String(MAX_PICTURE_BYTES / 1024 / 1024)} MB.`);
      return found;
    }
  };
}

/** A page to print, with the content policy the printer must hold it to. */
export interface PrintPage {
  html: string;
  policy: string;
}

export interface DocumentDeps {
  /** Prints a page to PDF. The signal aborts when the document is given up on, so the printer can close its window. */
  printPdf(page: PrintPage, signal: AbortSignal): Promise<Buffer>;
}

export class DocumentMaker {
  constructor(private readonly deps: DocumentDeps) {}

  /** Builds the document, giving up after a minute or when the turn is stopped. */
  make(kind: DocumentKind, source: string, options: { title: string; assets: DocumentAssets }, signal: AbortSignal): Promise<Buffer> {
    const work = new AbortController();
    return new Promise<Buffer>((resolve, reject) => {
      const settle = (done: () => void): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onStop);
        done();
      };
      const giveUp = (message: string): void => {
        work.abort();
        settle(() => reject(new Error(message)));
      };
      const onStop = (): void => giveUp('Stopped.');
      const timer = setTimeout(() => giveUp(`Building the document took longer than ${String(DOCUMENT_TIMEOUT_MS / 1000)} seconds.`), DOCUMENT_TIMEOUT_MS);
      if (signal.aborted) {
        onStop();
        return;
      }
      signal.addEventListener('abort', onStop, { once: true });
      this.build(kind, source, { title: options.title, assets: checked(options.assets) }, work.signal).then(
        (data) => settle(() => resolve(data)),
        (error: unknown) => settle(() => reject(error instanceof Error ? error : new Error(String(error))))
      );
    });
  }

  private async build(kind: DocumentKind, written: string, named: { title: string; assets: DocumentAssets }, signal: AbortSignal): Promise<Buffer> {
    // Characters no document can hold are dropped first, from the text and from the title.
    const { writable } = await import('./text');
    const source = writable(written);
    const options = { ...named, title: writable(named.title) };
    switch (kind) {
      case 'pdf': {
        const { PAGE_POLICY, markdownToHtml } = await import('./html');
        return this.deps.printPdf({ html: markdownToHtml(source, options), policy: PAGE_POLICY }, signal);
      }
      case 'docx':
        return (await import('./docx')).markdownToDocx(source, options);
      case 'pptx':
        return (await import('./pptx')).markdownToPptx(source, options);
      case 'xlsx': {
        const { parseSheets, sheetsToXlsx } = await import('./xlsx');
        return sheetsToXlsx(parseSheets(source));
      }
    }
  }
}
