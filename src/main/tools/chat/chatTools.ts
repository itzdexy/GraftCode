import { z } from 'zod';
import type { MadeFile } from '@shared/schemas/toolDisplay';
import { MAX_CHAT_FILE_BYTES, safeFileName } from '../../chat/chatFiles';
import { documentKind, MAX_DOCUMENT_SOURCE } from '../../chat/documents';
import { errorResult, textResult, type ToolDefinition } from '../types';

/**
 * Chat-only tools: CreateFile makes a file the user can download from the
 * conversation, and RunCode runs JavaScript in an isolated sandbox. Both
 * stay inside Graft (its own data folder and a page with no network), so
 * they run without asking. A file named .pdf, .docx, .pptx or .xlsx is
 * built from the Markdown or rows the model wrote.
 */

/**
 * Whether a name is one of the office formats, judged on the name the file
 * will have once saved ("report.docx." loses its dot). Graft builds these from
 * text and saves none it did not build: they open with one click in apps that
 * fetch, link and run what a file tells them to, so bytes a model wrote (or
 * code in the sandbox produced) are refused under those names.
 */
function isOfficeDocument(name: string): boolean {
  const kind = documentKind(safeFileName(name));
  return kind !== null && kind !== 'pdf';
}

function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function clipped(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}

/** The start of a text file, for the card's preview; null for other files. */
function textPreview(data: Buffer, mime: string): string | null {
  if (!/^text\/|json|xml|svg|javascript/.test(mime) || data.includes(0)) return null;
  const text = data.subarray(0, 4000).toString('utf8');
  return data.length > 4000 ? `${text}\n…` : text;
}

export const CreateFileInput = z.object({
  name: z.string().trim().min(1).max(120).describe('File name with its extension, e.g. "trip-plan.md", "report.pdf", "budget.xlsx" or "logo.svg".'),
  content: z.string().max(MAX_CHAT_FILE_BYTES).describe('The complete content of the file.'),
  encoding: z.enum(['utf8', 'base64']).optional().describe('"base64" when content is base64-encoded bytes (for binary files); plain text otherwise.')
});
export type CreateFileInput = z.infer<typeof CreateFileInput>;

export const createFileTool: ToolDefinition<CreateFileInput> = {
  name: 'CreateFile',
  description: [
    'Create a file the user can download from this chat: a document, notes, data (CSV, JSON), code, an SVG picture or a web page.',
    'Name the file .pdf or .docx and write its content in Markdown, and Graft builds the document.',
    'Name it .pptx and put a line of --- between slides: each slide starts with a heading (its title), then a list for its points, and may also hold a table, one picture and a line starting with "Note:" for the speaker\'s notes.',
    'Name it .xlsx and give the rows as CSV or a JSON list of rows, or as a JSON object of sheet name to rows for several sheets; a cell that starts with = is a formula.',
    'A picture made in this chat is placed in a document with ![what it shows](its-file-name.png).',
    'Give the whole content at once. Each call makes a new file; reusing a name adds a number instead of replacing the earlier file.'
  ].join(' '),
  input: CreateFileInput,
  permissionClass: 'none',
  concurrencySafe: () => true,
  // A document may take up to a minute to build.
  timeoutMs: 75_000,
  describe(input) {
    return Promise.resolve({ summary: `Creating ${input.name}`, preview: { kind: 'generic', text: `Create ${input.name}` } });
  },
  async execute(input, ctx) {
    if (!ctx.chatFiles) return errorResult('Files can be created in chats only (not in incognito chats).');
    if (input.encoding === 'base64' && isOfficeDocument(input.name)) {
      return errorResult('Graft builds .docx, .pptx and .xlsx files itself: give the content as Markdown (rows for a spreadsheet), not as bytes.');
    }
    // Bytes are saved as they are, and so is a PDF the model already has; anything else named like a document is built.
    const kind = input.encoding === 'base64' ? null : documentKind(safeFileName(input.name));
    const built = kind !== null && !(kind === 'pdf' && input.content.startsWith('%PDF-'));
    let data: Buffer;
    if (built) {
      if (!ctx.makeDocument) return errorResult('Documents can be built in chats only (not in incognito chats).');
      if (input.content.length > MAX_DOCUMENT_SOURCE) return errorResult('The text of a document can be up to 2 MB.');
      try {
        data = await ctx.makeDocument(kind, input.name, input.content, ctx.signal);
      } catch (error) {
        return errorResult(`Couldn't build ${input.name}: ${(error as Error).message}`);
      }
    } else {
      data = input.encoding === 'base64' ? Buffer.from(input.content, 'base64') : Buffer.from(input.content, 'utf8');
    }
    let file;
    try {
      file = ctx.chatFiles.save(input.name, data);
    } catch (error) {
      return errorResult(`Couldn't create ${input.name}: ${(error as Error).message}`);
    }
    const from = built ? `, built from the ${kind === 'xlsx' ? 'rows' : 'Markdown'} you wrote` : '';
    return textResult(`Created ${file.name} (${size(file.size)})${from}. The user sees it in the chat with buttons to save or open it.`, {
      kind: 'file',
      name: file.name,
      size: file.size,
      mime: file.mime,
      // A built document shows what it was built from; a text file its own start.
      preview: built ? clipped(input.content) : textPreview(data, file.mime)
    });
  }
};

export const RunCodeInput = z.object({
  code: z
    .string()
    .min(1)
    .max(200_000)
    .describe('JavaScript to run, as the body of an async function: await works, console.log prints, and a returned value is shown. graft.writeFile(name, data) creates a file the user can download.'),
  timeout_seconds: z.number().int().min(1).max(60).optional().describe('Time limit in seconds (default 20).')
});
export type RunCodeInput = z.infer<typeof RunCodeInput>;

export const runCodeTool: ToolDefinition<RunCodeInput> = {
  name: 'RunCode',
  description: [
    'Run JavaScript in an isolated sandbox and get back what it printed, its return value and any files it created.',
    'The sandbox has the standard JavaScript and web APIs (Math, Date, Intl, JSON, TextEncoder, crypto.subtle, typed arrays) but no network, no packages and no access to the computer.',
    'Use it to calculate, convert or analyse data, generate content and check that code works.'
  ].join(' '),
  input: RunCodeInput,
  permissionClass: 'none',
  concurrencySafe: () => false,
  timeoutMs: 75_000,
  describe() {
    return Promise.resolve({ summary: 'Running code', preview: { kind: 'generic', text: 'Run JavaScript in the sandbox' } });
  },
  async execute(input, ctx) {
    if (!ctx.runCode) return errorResult('Code can be run in chats only.');
    const run = await ctx.runCode(input.code, (input.timeout_seconds ?? 20) * 1000, ctx.signal);
    const saved: MadeFile[] = [];
    const failures: string[] = [];
    for (const file of run.files) {
      if (!ctx.chatFiles) {
        failures.push(`${file.name}: files can't be saved in this chat`);
        continue;
      }
      if (isOfficeDocument(file.name)) {
        failures.push(`${file.name}: a document like this is made with CreateFile, from Markdown or rows`);
        continue;
      }
      try {
        const made = ctx.chatFiles.save(file.name, file.data);
        saved.push({ name: made.name, size: made.size, mime: made.mime });
      } catch (error) {
        failures.push(`${file.name}: ${(error as Error).message}`);
      }
    }
    const parts = [run.output ? `Output:\n${run.output}` : 'No output.'];
    if (run.error) parts.push(`Error:\n${run.error}`);
    if (saved.length > 0) parts.push(`Created ${saved.map((f) => `${f.name} (${size(f.size)})`).join(', ')}; the user can download them from the chat.`);
    if (failures.length > 0) parts.push(`Not saved: ${failures.join('; ')}`);
    return textResult(
      parts.join('\n\n'),
      { kind: 'code', code: input.code, output: run.output, error: run.error, timedOut: run.timedOut, durationMs: run.durationMs, files: saved },
      run.error !== null
    );
  }
};
