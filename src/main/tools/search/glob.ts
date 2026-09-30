import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { displayPath, resolvePath } from '../paths';
import { runFile } from '../run';
import { errorResult, textResult, type ToolDefinition } from '../types';

const MAX_RESULTS = 200;
const MAX_STATS = 2000;

export const GlobInput = z.object({
  pattern: z.string().min(1).describe('Glob pattern, e.g. "**/*.ts" or "src/**/*.test.tsx". A pattern without "/" matches at any depth.'),
  path: z.string().optional().describe('Directory to search (default: the working directory).')
});
export type GlobInput = z.infer<typeof GlobInput>;

export const globTool: ToolDefinition<GlobInput> = {
  name: 'Glob',
  description: [
    'Find files by name pattern. Respects .gitignore and skips .git.',
    `Returns up to ${MAX_RESULTS} paths, most recently modified first.`
  ].join(' '),
  input: GlobInput,
  permissionClass: 'read',
  concurrencySafe: () => true,
  timeoutMs: 60_000,
  describe(input, ctx) {
    const dir = resolvePath(input.path ?? '.', ctx.cwd);
    return Promise.resolve({ summary: `Find files matching ${input.pattern}`, reads: [dir], preview: { kind: 'path', path: dir, access: 'read' } });
  },
  async execute(input, ctx) {
    const dir = resolvePath(input.path ?? '.', ctx.cwd);
    const shown = displayPath(dir, ctx.projectRoot, ctx.platform);
    try {
      if (!(await fs.promises.stat(dir)).isDirectory()) return errorResult(`${shown} is not a directory.`);
    } catch {
      return errorResult(`Directory not found: ${shown}.`);
    }
    const result = await runFile(
      ctx.rgPath,
      ['--files', '--hidden', '--no-config', '--no-messages', '--glob', input.pattern, '--glob', '!.git'],
      { cwd: dir, signal: ctx.signal, timeoutMs: 60_000 }
    );
    if (result.code !== 0 && result.code !== 1) {
      return errorResult(`File search failed: ${result.stderr.trim() || `exit code ${String(result.code)}`}`);
    }
    const files = result.stdout.split(/\r?\n/).filter((l) => l.length > 0);
    const withTimes = await Promise.all(
      files.slice(0, MAX_STATS).map(async (rel) => {
        const abs = path.join(dir, rel);
        const mtime = await fs.promises.stat(abs).then((s) => s.mtimeMs, () => 0);
        return { abs, mtime };
      })
    );
    withTimes.sort((a, b) => b.mtime - a.mtime);
    const shownFiles = withTimes.slice(0, MAX_RESULTS).map((f) => displayPath(f.abs, ctx.cwd, ctx.platform));
    const header = files.length === 0 ? `No files match ${input.pattern} in ${shown}.` : `${files.length} file${files.length === 1 ? '' : 's'} match ${input.pattern} in ${shown}:`;
    const more = files.length > MAX_RESULTS ? `\n… ${files.length - MAX_RESULTS} more. Narrow the pattern to see them.` : '';
    return textResult([header, ...shownFiles].join('\n') + more, {
      kind: 'glob',
      pattern: input.pattern,
      count: files.length,
      files: shownFiles.slice(0, 50)
    });
  }
};
