import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { displayPath, resolvePath } from '../paths';
import { runFile } from '../run';
import { errorResult, textResult, type ToolContext, type ToolDefinition, type ToolResult } from '../types';
import {
  aliasesFrom,
  definitionRegex,
  importSpecifiers,
  importsTarget,
  isTestFile,
  LANGUAGE_NAMES,
  languageOf,
  moduleStem,
  outlineOf,
  testNameGlobs,
  type PathAlias
} from './symbolPatterns';

export const SymbolsInput = z.object({
  action: z
    .enum(['outline', 'definition', 'references', 'importers', 'tests'])
    .describe(
      '"outline": the definitions in a file. "definition": where a name is defined. "references": where a name is used, by file. "importers": which files import a file. "tests": the tests of a file (named after it, or importing it).'
    ),
  name: z.string().min(1).max(200).optional().describe('The symbol for "definition" and "references": a function, class, type, variable or macro name.'),
  path: z.string().optional().describe('The file for "outline", "importers" and "tests"; a folder to search in for "definition" and "references" (default: the working directory).')
});
export type SymbolsInput = z.infer<typeof SymbolsInput>;

const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Occurrences read per file: a name used more often than this in one file is common enough that the rest add nothing. */
const MAX_PER_FILE = 200;
const MAX_HITS = 5_000;
const SHOWN_FILES = 40;
const SHOWN_LINES_PER_FILE = 5;
const SHOWN_DEFINITIONS = 40;

/** ripgrep arguments every search here shares: honour .gitignore even outside a git repository, and never read dependencies or git's own files. */
const BASE_ARGS = ['--no-config', '--color=never', '--hidden', '--no-require-git', '--glob', '!.git', '--glob', '!node_modules'];

interface Hit {
  /** Relative to the folder searched, with forward slashes. */
  file: string;
  line: number;
  text: string;
}

function slashes(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Every line that mentions `text` under `root` (whole words, when the text is one). */
async function occurrences(text: string, root: string, ctx: ToolContext, fileGlobs: string[] = []): Promise<{ hits: Hit[]; cut: boolean } | { error: string }> {
  const wordish = /^[\w$]+$/.test(text) && !text.includes('$');
  const args = [
    ...BASE_ARGS,
    '--line-number',
    '--no-heading',
    '--with-filename',
    '--max-columns',
    '300',
    '--max-columns-preview',
    '--max-count',
    String(MAX_PER_FILE),
    ...(wordish ? ['--word-regexp'] : []),
    ...fileGlobs.flatMap((glob) => ['--glob', glob]),
    '--fixed-strings',
    '--regexp',
    text,
    '--',
    '.'
  ];
  const result = await runFile(ctx.rgPath, args, { cwd: root, signal: ctx.signal, timeoutMs: 60_000 });
  if (result.code === 2 || result.code === null) return { error: result.stderr.trim().split('\n').slice(0, 3).join('\n') || 'ripgrep error' };
  const lines = result.stdout.split(/\r?\n/).filter((l) => l.length > 0);
  const hits: Hit[] = [];
  for (const line of lines.slice(0, MAX_HITS)) {
    const match = /^(.+?):(\d+):(.*)$/.exec(line);
    if (match?.[1] && match[2]) hits.push({ file: slashes(match[1]), line: Number(match[2]), text: match[3] ?? '' });
  }
  return { hits, cut: lines.length > MAX_HITS };
}

function grepDisplay(label: string, count: number, text: string): ToolResult {
  return textResult(text, { kind: 'grep', pattern: label, count, preview: text.split('\n').slice(0, 20).join('\n') });
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed;
}

/** tsconfig and jsconfig "paths" at the project root, so imports through an alias are followed. */
function projectAliases(root: string): PathAlias[] {
  let names: string[];
  try {
    names = fs.readdirSync(root).filter((name) => /^(tsconfig|jsconfig)(\.[\w-]+)?\.json$/.test(name));
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: PathAlias[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, name), 'utf8');
    } catch {
      continue;
    }
    for (const alias of aliasesFrom(text)) {
      if (seen.has(alias.prefix)) continue;
      seen.add(alias.prefix);
      out.push(alias);
    }
  }
  return out;
}

async function outline(target: string, ctx: ToolContext): Promise<ToolResult> {
  const shown = displayPath(target, ctx.cwd, ctx.platform);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(target);
  } catch {
    return errorResult(`File not found: ${shown}.`);
  }
  if (!stat.isFile()) return errorResult(`${shown} is a folder. Give a file to outline, or use Glob to list the folder.`);
  if (stat.size > MAX_FILE_BYTES) return errorResult(`${shown} is too large to outline (${String(Math.round(stat.size / 1024))} KB). Use Grep on it instead.`);
  const language = languageOf(target);
  if (!language) return errorResult(`There is no outline for ${path.extname(target) || 'this kind of'} files. Use Read.`);
  const text = await fs.promises.readFile(target, 'utf8');
  const definitions = outlineOf(text, language);
  const lineCount = text.split(/\r?\n/).length;
  if (definitions.length === 0) return grepDisplay(`outline of ${shown}`, 0, `No definitions found in ${shown} (${LANGUAGE_NAMES[language]}, ${String(lineCount)} lines).`);
  // Each definition as it is written: the line says what kind of thing it is and what it takes.
  const width = String(definitions.at(-1)?.line ?? 0).length;
  const rows = definitions.map((d) => `${String(d.line).padStart(width)}: ${d.text}`);
  return grepDisplay(`outline of ${shown}`, definitions.length, [`${shown} (${LANGUAGE_NAMES[language]}, ${String(lineCount)} lines), ${String(definitions.length)} definitions:`, ...rows].join('\n'));
}

async function definitionOrReferences(action: 'definition' | 'references', name: string, target: string, ctx: ToolContext): Promise<ToolResult> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(target);
  } catch {
    return errorResult(`Path not found: ${displayPath(target, ctx.cwd, ctx.platform)}.`);
  }
  const root = stat.isDirectory() ? target : path.dirname(target);
  const found = await occurrences(name, root, ctx, stat.isDirectory() ? [] : [path.basename(target)]);
  if ('error' in found) return errorResult(`Search failed: ${found.error}`);
  const show = (file: string): string => displayPath(path.join(root, file), ctx.cwd, ctx.platform);
  const defines = definitionRegex(name);
  const definitions = found.hits.filter((hit) => defines.test(hit.text));
  const definedAt = new Set(definitions.map((hit) => `${hit.file}:${String(hit.line)}`));

  if (action === 'definition') {
    if (definitions.length === 0) {
      return grepDisplay(
        `definition of ${name}`,
        0,
        `No definition of ${name} found${found.hits.length > 0 ? ` (it is used in ${String(new Set(found.hits.map((h) => h.file)).size)} files)` : ''}. It may come from a dependency, be generated, or be defined in a way this search doesn't recognize: try Grep.`
      );
    }
    // Source before tests: the definition people mean is rarely the one in a test.
    const ordered = [...definitions].sort((a, b) => Number(isTestFile(a.file)) - Number(isTestFile(b.file)));
    const rows = ordered.slice(0, SHOWN_DEFINITIONS).map((hit) => `${show(hit.file)}:${String(hit.line)}  ${clip(hit.text)}`);
    const more = ordered.length > SHOWN_DEFINITIONS ? [`… ${String(ordered.length - SHOWN_DEFINITIONS)} more.`] : [];
    return grepDisplay(`definition of ${name}`, definitions.length, [`${name} is defined in ${String(definitions.length)} ${definitions.length === 1 ? 'place' : 'places'}:`, ...rows, ...more].join('\n'));
  }

  const uses = found.hits.filter((hit) => !definedAt.has(`${hit.file}:${String(hit.line)}`));
  const byFile = new Map<string, Hit[]>();
  for (const hit of uses) byFile.set(hit.file, [...(byFile.get(hit.file) ?? []), hit]);
  const files = [...byFile.entries()].sort((a, b) => Number(isTestFile(a[0])) - Number(isTestFile(b[0])) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const tests = files.filter(([file]) => isTestFile(file)).length;
  const header = definitions.slice(0, 5).map((hit) => `Defined in ${show(hit.file)}:${String(hit.line)}  ${clip(hit.text)}`);
  if (files.length === 0) {
    return grepDisplay(`uses of ${name}`, 0, [...header, definitions.length > 0 ? `${name} is defined but not used anywhere else under ${displayPath(root, ctx.cwd, ctx.platform)}.` : `No uses of ${name} found.`].join('\n'));
  }
  const summary = `${name}: ${String(uses.length)} ${uses.length === 1 ? 'use' : 'uses'} in ${String(files.length)} ${files.length === 1 ? 'file' : 'files'}${tests > 0 ? ` (${String(tests)} of them tests)` : ''}.`;
  const rows = files.slice(0, SHOWN_FILES).flatMap(([file, hits]) => [
    `${show(file)}${isTestFile(file) ? ' (test)' : ''}${hits.length > SHOWN_LINES_PER_FILE ? `, ${String(hits.length)} uses` : ''}`,
    ...hits.slice(0, SHOWN_LINES_PER_FILE).map((hit) => `  ${String(hit.line)}: ${clip(hit.text)}`)
  ]);
  const more = [
    ...(files.length > SHOWN_FILES ? [`… ${String(files.length - SHOWN_FILES)} more files. Give a folder as path to narrow it.`] : []),
    ...(found.cut ? ['The name is very common: only the first matches were read.'] : [])
  ];
  return grepDisplay(`uses of ${name}`, uses.length, [...header, summary, ...rows, ...more].join('\n'));
}

/** The files under `root` that import `target` (a path relative to root, forward slashes), each with the line that does. */
async function findImporters(target: string, root: string, ctx: ToolContext): Promise<{ sure: Hit[]; maybe: Hit[] } | { error: string }> {
  const found = await occurrences(moduleStem(target), root, ctx);
  if ('error' in found) return found;
  const aliases = projectAliases(root);
  const exists = (file: string): boolean => {
    try {
      return fs.statSync(path.join(root, file)).isFile();
    } catch {
      return false;
    }
  };
  const sure = new Map<string, Hit>();
  const maybe = new Map<string, Hit>();
  for (const hit of found.hits) {
    if (hit.file === target || sure.has(hit.file)) continue;
    const language = languageOf(hit.file);
    for (const specifier of importSpecifiers(hit.text, language)) {
      const verdict = importsTarget(specifier, language, hit.file, target, exists, aliases);
      if (verdict === 'yes') {
        sure.set(hit.file, hit);
        maybe.delete(hit.file);
        break;
      }
      if (verdict === 'maybe' && !maybe.has(hit.file)) maybe.set(hit.file, hit);
    }
  }
  return { sure: [...sure.values()], maybe: [...maybe.values()] };
}

async function fileTarget(input: SymbolsInput, ctx: ToolContext): Promise<{ abs: string; rel: string; root: string; shown: string } | ToolResult> {
  const abs = resolvePath(input.path ?? '', ctx.cwd);
  const shown = displayPath(abs, ctx.cwd, ctx.platform);
  try {
    if (!(await fs.promises.stat(abs)).isFile()) return errorResult(`${shown} is a folder. Give the file.`);
  } catch {
    return errorResult(`File not found: ${shown}.`);
  }
  const root = ctx.projectRoot;
  const rel = slashes(path.relative(root, abs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return errorResult(`${shown} is outside the project, so there is nothing here that could import it.`);
  return { abs, rel, root, shown };
}

async function importers(input: SymbolsInput, ctx: ToolContext): Promise<ToolResult> {
  const target = await fileTarget(input, ctx);
  if ('isError' in target) return target;
  const found = await findImporters(target.rel, target.root, ctx);
  if ('error' in found) return errorResult(`Search failed: ${found.error}`);
  const show = (hit: Hit): string => `${displayPath(path.join(target.root, hit.file), ctx.cwd, ctx.platform)}:${String(hit.line)}${isTestFile(hit.file) ? ' (test)' : ''}`;
  const sure = [...found.sure].sort((a, b) => Number(isTestFile(a.file)) - Number(isTestFile(b.file)) || a.file.localeCompare(b.file));
  if (sure.length === 0 && found.maybe.length === 0) {
    return grepDisplay(`importers of ${target.shown}`, 0, `Nothing imports ${target.shown}. It may be an entry point, be loaded by name at run time, or be unused.`);
  }
  const rows = [
    ...(sure.length > 0 ? [`${String(sure.length)} ${sure.length === 1 ? 'file imports' : 'files import'} ${target.shown}:`, ...sure.slice(0, 80).map((hit) => `  ${show(hit)}`)] : [`No file imports ${target.shown} in a way that could be followed.`]),
    ...(sure.length > 80 ? [`  … ${String(sure.length - 80)} more.`] : []),
    ...(found.maybe.length > 0 ? [`Possibly also (the import couldn't be followed to a file):`, ...found.maybe.slice(0, 20).map((hit) => `  ${show(hit)}  ${clip(hit.text)}`)] : [])
  ];
  return grepDisplay(`importers of ${target.shown}`, sure.length, rows.join('\n'));
}

async function tests(input: SymbolsInput, ctx: ToolContext): Promise<ToolResult> {
  const target = await fileTarget(input, ctx);
  if ('isError' in target) return target;
  const named = await runFile(ctx.rgPath, [...BASE_ARGS, '--files', ...testNameGlobs(target.rel).flatMap((glob) => ['--glob', glob])], { cwd: target.root, signal: ctx.signal, timeoutMs: 60_000 });
  if (named.code === 2 || named.code === null) return errorResult(`Search failed: ${named.stderr.trim().split('\n').slice(0, 3).join('\n') || 'ripgrep error'}`);
  const byName = named.stdout
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map(slashes)
    .filter((file) => file !== target.rel);
  const imported = await findImporters(target.rel, target.root, ctx);
  if ('error' in imported) return errorResult(`Search failed: ${imported.error}`);
  const byImport = imported.sure.filter((hit) => isTestFile(hit.file)).map((hit) => hit.file);
  const all = [...new Set([...byName, ...byImport])].sort();
  if (all.length === 0) {
    return grepDisplay(`tests of ${target.shown}`, 0, `No tests found for ${target.shown}: no test file is named after it and none imports it. It may be tested through other code: try "references" on what it exports.`);
  }
  const why = (file: string): string => (byName.includes(file) && byImport.includes(file) ? 'named after it and imports it' : byName.includes(file) ? 'named after it' : 'imports it');
  const rows = all.map((file) => `  ${displayPath(path.join(target.root, file), ctx.cwd, ctx.platform)}  (${why(file)})`);
  return grepDisplay(`tests of ${target.shown}`, all.length, [`${String(all.length)} test ${all.length === 1 ? 'file' : 'files'} for ${target.shown}:`, ...rows].join('\n'));
}

export const symbolsTool: ToolDefinition<SymbolsInput> = {
  name: 'Symbols',
  description: [
    'Answers questions about the code\'s structure in one step: the definitions in a file ("outline"), where a name is defined ("definition"),',
    'every use of a name grouped by file with tests marked ("references"), which files import a file ("importers"), and which tests cover a file ("tests").',
    'Use it before a broad Grep when you need to know what a change touches. It reads the text with patterns (JavaScript/TypeScript, Python, Go, Rust, Java, Kotlin, C#, C/C++, Ruby, PHP, Swift),',
    'so check what it finds with Read before relying on it, and fall back to Grep for anything it says it cannot find.'
  ].join(' '),
  input: SymbolsInput,
  permissionClass: 'read',
  concurrencySafe: () => true,
  timeoutMs: 120_000,
  describe(input, ctx) {
    const target = resolvePath(input.path ?? '.', ctx.cwd);
    const what =
      input.action === 'outline'
        ? `Outline ${input.path ?? ''}`
        : input.action === 'definition'
          ? `Find the definition of ${input.name ?? ''}`
          : input.action === 'references'
            ? `Find uses of ${input.name ?? ''}`
            : input.action === 'importers'
              ? `Find what imports ${input.path ?? ''}`
              : `Find the tests of ${input.path ?? ''}`;
    // Importers and tests look through the whole project for the file.
    const reads = input.action === 'importers' || input.action === 'tests' ? [ctx.projectRoot] : [target];
    return Promise.resolve({ summary: what.trim(), reads, preview: { kind: 'path', path: reads[0] ?? target, access: 'read' } });
  },
  async execute(input, ctx) {
    switch (input.action) {
      case 'outline':
        if (!input.path) return errorResult('Give the file to outline as path.');
        return outline(resolvePath(input.path, ctx.cwd), ctx);
      case 'definition':
      case 'references':
        if (!input.name) return errorResult(`Give the name to look for as name.`);
        return definitionOrReferences(input.action, input.name, resolvePath(input.path ?? '.', ctx.cwd), ctx);
      case 'importers':
        if (!input.path) return errorResult('Give the file as path.');
        return importers(input, ctx);
      case 'tests':
        if (!input.path) return errorResult('Give the file as path.');
        return tests(input, ctx);
    }
  }
};
