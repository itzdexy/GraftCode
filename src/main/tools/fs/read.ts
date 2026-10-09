import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ImageBlock, ToolResultContent } from '@shared/schemas/messages';
import { displayPath, resolvePath } from '../paths';
import { errorResult, type ToolDefinition } from '../types';

const DEFAULT_LIMIT = 2000;
const MAX_LINE = 2000;
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, ImageBlock['mediaType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

export const ReadInput = z.object({
  file_path: z.string().min(1).describe('Path to the file, absolute or relative to the working directory.'),
  offset: z.number().int().min(1).optional().describe('1-based line number to start reading from.'),
  limit: z.number().int().min(1).max(5000).optional().describe(`Maximum number of lines to return (default ${DEFAULT_LIMIT}).`)
});
export type ReadInput = z.infer<typeof ReadInput>;

export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

export function formatLines(lines: string[], start: number): string {
  const width = Math.max(6, String(start + lines.length - 1).length);
  return lines
    .map((line, i) => {
      const clipped = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… [line truncated]` : line;
      return `${String(start + i).padStart(width)}\t${clipped}`;
    })
    .join('\n');
}

export const readTool: ToolDefinition<ReadInput> = {
  name: 'Read',
  description: [
    'Read a text file with line numbers (cat -n style), or view an image.',
    `Returns up to ${DEFAULT_LIMIT} lines by default; use offset/limit for large files.`,
    'Lines longer than 2000 characters are truncated. Binary files are not shown.',
    'Always Read a file before editing it.'
  ].join(' '),
  input: ReadInput,
  permissionClass: 'read',
  concurrencySafe: () => true,
  timeoutMs: 30_000,
  describe(input, ctx) {
    const abs = resolvePath(input.file_path, ctx.cwd);
    const range = input.offset ? ` (from line ${input.offset})` : '';
    return Promise.resolve({
      summary: `Read ${displayPath(abs, ctx.projectRoot, ctx.platform)}${range}`,
      reads: [abs],
      preview: { kind: 'path', path: abs, access: 'read' }
    });
  },
  async execute(input, ctx) {
    const abs = resolvePath(input.file_path, ctx.cwd);
    const shown = displayPath(abs, ctx.projectRoot, ctx.platform);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      return errorResult(`File not found: ${shown}. Check the path, or use Glob to find it.`);
    }
    if (stat.isDirectory()) return errorResult(`${shown} is a directory. Use Glob to list files.`);
    const ext = path.extname(abs).toLowerCase();

    const imageType = IMAGE_TYPES[ext];
    if (imageType) {
      if (stat.size > MAX_IMAGE_BYTES) return errorResult(`${shown} is ${(stat.size / 1048576).toFixed(1)} MB; images over 5 MB are not read.`);
      ctx.files.record(abs);
      const display = { kind: 'read' as const, path: shown, startLine: 0, endLine: 0, totalLines: 0, image: true };
      if (!ctx.modelSupportsVision) {
        return { isError: false, content: [{ type: 'text', text: `${shown} is an image, but the current model can't view images.` }], display };
      }
      const data = (await fs.promises.readFile(abs)).toString('base64');
      return { isError: false, content: [{ type: 'image', mediaType: imageType, data }], display };
    }
    if (ext === '.pdf') return errorResult(`${shown} is a PDF. Read can't extract PDF text; use a command-line tool if one is installed.`);
    if (stat.size > MAX_TEXT_BYTES) {
      return errorResult(`${shown} is ${(stat.size / 1048576).toFixed(1)} MB. Use Grep, or Shell with head/tail, to inspect parts of it.`);
    }

    const buffer = await fs.promises.readFile(abs);
    if (looksBinary(buffer)) return errorResult(`${shown} is a binary file (${stat.size} bytes); its contents are not shown.`);
    ctx.files.record(abs, buffer);

    const decoded = buffer.toString('utf8');
    const text = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines.at(-1) === '') lines.pop();
    const total = lines.length;
    const start = input.offset ?? 1;
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (total === 0) {
      return {
        isError: false,
        content: [{ type: 'text', text: '(file is empty)' }],
        display: { kind: 'read', path: shown, startLine: 0, endLine: 0, totalLines: 0, image: false }
      };
    }
    if (start > total) return errorResult(`offset ${start} is past the end of ${shown} (${total} lines).`);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const end = start + slice.length - 1;
    let body = formatLines(slice, start);
    if (end < total) body += `\n… ${total - end} more lines. Continue with offset=${end + 1}.`;

    const content: ToolResultContent[] = [{ type: 'text', text: body }];
    const notes = ctx.notesForPaths([abs]);
    if (notes) content.push({ type: 'text', text: notes });
    return {
      isError: false,
      content,
      display: { kind: 'read', path: shown, startLine: start, endLine: end, totalLines: total, image: false }
    };
  }
};
