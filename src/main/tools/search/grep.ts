import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { displayPath, resolvePath } from '../paths';
import { runFile } from '../run';
import { errorResult, textResult, type ToolDefinition } from '../types';

export const GrepInput = z.object({
  pattern: z.string().min(1).describe('Regular expression (Rust regex syntax; escape literal braces).'),
  path: z.string().optional().describe('File or directory to search (default: the working directory).'),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.tsx" or "src/**".'),
  type: z.string().optional().describe('Only search this ripgrep file type, e.g. "ts", "py", "rust".'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe('"content" shows matching lines, "files_with_matches" (default) lists files, "count" counts per file.'),
  case_insensitive: z.boolean().optional(),
  context: z.number().int().min(0).max(20).optional().describe('Lines of context around each match (content mode).'),
  before: z.number().int().min(0).max(20).optional(),
  after: z.number().int().min(0).max(20).optional(),
  multiline: z.boolean().optional().describe('Allow patterns to span lines ("." matches newlines).'),
  head_limit: z.number().int().min(1).max(2000).optional().describe('Maximum output lines (default 250 for content, 200 otherwise).')
});
export type GrepInput = z.infer<typeof GrepInput>;

export function grepArgs(input: GrepInput, target: string): string[] {
  const mode = input.output_mode ?? 'files_with_matches';
  const args = ['--no-config', '--color=never', '--hidden', '--glob', '!.git', '--max-columns', '400', '--max-columns-preview'];
  if (mode === 'content') {
    args.push('--line-number', '--no-heading', '--with-filename');
    if (input.context !== undefined) args.push('--context', String(input.context));
    if (input.before !== undefined) args.push('--before-context', String(input.before));
    if (input.after !== undefined) args.push('--after-context', String(input.after));
  } else if (mode === 'files_with_matches') {
    args.push('--files-with-matches');
  } else {
    args.push('--count', '--with-filename');
  }
  if (input.case_insensitive) args.push('--ignore-case');
  if (input.multiline) args.push('--multiline', '--multiline-dotall');
  if (input.glob) args.push('--glob', input.glob);
  if (input.type) args.push('--type', input.type);
  args.push('--regexp', input.pattern, '--', target);
  return args;
}

export const grepTool: ToolDefinition<GrepInput> = {
  name: 'Grep',
  description: [
    'Search file contents with ripgrep. Respects .gitignore and skips .git.',
    'Use output_mode "content" with context lines to see matches, "files_with_matches" to locate files.'
  ].join(' '),
  input: GrepInput,
  permissionClass: 'read',
  concurrencySafe: () => true,
  timeoutMs: 60_000,
  describe(input, ctx) {
    const target = resolvePath(input.path ?? '.', ctx.cwd);
    return Promise.resolve({ summary: `Search for ${input.pattern}`, reads: [target], preview: { kind: 'path', path: target, access: 'read' } });
  },
  async execute(input, ctx) {
    const target = resolvePath(input.path ?? '.', ctx.cwd);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(target);
    } catch {
      return errorResult(`Path not found: ${displayPath(target, ctx.projectRoot, ctx.platform)}.`);
    }
    const cwd = stat.isDirectory() ? target : path.dirname(target);
    const arg = stat.isDirectory() ? '.' : path.basename(target);
    const result = await runFile(ctx.rgPath, grepArgs(input, arg), { cwd, signal: ctx.signal, timeoutMs: 60_000 });
    if (result.code === 2 || result.code === null) {
      return errorResult(`Search failed: ${result.stderr.trim().split('\n').slice(0, 5).join('\n') || 'ripgrep error'}`);
    }
    const mode = input.output_mode ?? 'files_with_matches';
    const lines = result.stdout.split(/\r?\n/).filter((l) => l.length > 0);
    const limit = input.head_limit ?? (mode === 'content' ? 250 : 200);
    // Show paths relative to the working directory, whatever directory rg ran in.
    const rebase = (line: string): string => {
      if (!stat.isDirectory()) return line.startsWith(arg) ? displayPath(target, ctx.cwd, ctx.platform) + line.slice(arg.length) : line;
      const rel = line.replace(/^\.[\\/]/, '');
      const sep = mode === 'files_with_matches' ? -1 : rel.search(/[:-]\d+[:-]|:\d+$/);
      const file = sep === -1 ? rel : rel.slice(0, sep);
      return displayPath(path.join(cwd, file), ctx.cwd, ctx.platform) + (sep === -1 ? '' : rel.slice(sep));
    };
    const shown = lines.slice(0, limit).map(rebase);
    const unit = mode === 'content' ? 'matching lines' : mode === 'count' ? 'files with counts' : 'files';
    const header = lines.length === 0 ? `No matches for ${input.pattern}.` : `${lines.length} ${unit}:`;
    const more = lines.length > limit ? `\n… ${lines.length - limit} more. Narrow the search or raise head_limit.` : '';
    return textResult([header, ...shown].join('\n') + more, {
      kind: 'grep',
      pattern: input.pattern,
      count: lines.length,
      preview: shown.slice(0, 20).join('\n')
    });
  }
};
