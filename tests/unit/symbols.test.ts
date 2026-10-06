import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { textOf } from '../../src/shared/schemas/messages';
import { aliasesFrom, definitionRegex, importSpecifiers, isTestFile, languageOf, outlineOf, resolveSpecifier, testNameGlobs } from '../../src/main/tools/search/symbolPatterns';
import { symbolsTool } from '../../src/main/tools/search/symbols';
import { makeTempDir, removeDir } from '../support/tmp';
import { makeToolContext } from '../support/toolContext';

const names = (text: string, file: string): Array<[string, string]> => outlineOf(text, languageOf(file)).map((d) => [d.kind, d.name]);

describe('reading the definitions out of a file', () => {
  it('knows the languages it can outline by their file names', () => {
    expect(['a.ts', 'a.tsx', 'a.mjs', 'a.py', 'a.go', 'a.rs', 'A.java', 'a.kt', 'a.cs', 'a.c', 'a.hpp', 'a.rb', 'a.php', 'a.swift'].map(languageOf)).toEqual([
      'js',
      'js',
      'js',
      'python',
      'go',
      'rust',
      'java',
      'java',
      'java',
      'c',
      'c',
      'ruby',
      'php',
      'swift'
    ]);
    expect(languageOf('notes.md')).toBeNull();
  });

  it('finds functions, classes, types and their methods in TypeScript, and skips what only looks like one', () => {
    const text = [
      "import { z } from 'zod';",
      'export interface Options { depth: number }',
      'export type Mode = "a" | "b";',
      'export enum Level { Low, High }',
      'export const LIMIT = 10;',
      'const hidden = 1;',
      'export const handler = async (req: Request): Promise<void> => {',
      '  if (req.ok) {',
      '    run(req);',
      '  }',
      '};',
      'export default async function main(argv: string[]) {}',
      'function* walk() {}',
      'export abstract class Store<T> {',
      '  private items: T[] = [];',
      '  constructor(private readonly db: Db) {}',
      '  async load(id: string): Promise<T> {',
      '    for (const x of this.items) {',
      '      return x;',
      '    }',
      '  }',
      '  static create(): Store<unknown> {',
      '  }',
      '}'
    ].join('\n');
    expect(names(text, 'store.ts')).toEqual([
      ['interface', 'Options'],
      ['type', 'Mode'],
      ['enum', 'Level'],
      ['const', 'LIMIT'],
      ['const', 'hidden'],
      ['function', 'handler'],
      ['function', 'main'],
      ['function', 'walk'],
      ['class', 'Store'],
      ['method', 'constructor'],
      ['method', 'load'],
      ['method', 'create']
    ]);
    const outline = outlineOf(text, 'js');
    expect(outline.find((d) => d.name === 'load')).toMatchObject({ line: 17, text: 'async load(id: string): Promise<T> {' });
  });

  it('finds definitions in Python, Go and Rust', () => {
    expect(names(['class Limiter(Base):', '    def allow(self, key):', '        pass', 'async def main():', '    pass', 'LIMIT = 5'].join('\n'), 'limiter.py')).toEqual([
      ['class', 'Limiter'],
      ['method', 'allow'],
      ['function', 'main']
    ]);
    expect(names(['package limiter', 'type Bucket struct {', '}', 'type Store interface {', '}', 'func New(n int) *Bucket {', '}', 'func (b *Bucket) Allow() bool {', '}'].join('\n'), 'bucket.go')).toEqual([
      ['struct', 'Bucket'],
      ['interface', 'Store'],
      ['function', 'New'],
      ['method', 'Allow']
    ]);
    expect(names(['pub struct Bucket {', '}', 'impl Bucket {', '    pub async fn allow(&self) -> bool {', '    }', '}', 'pub(crate) trait Store {}', 'fn main() {}', 'pub enum Mode { A }'].join('\n'), 'bucket.rs')).toEqual([
      ['struct', 'Bucket'],
      ['impl', 'Bucket'],
      ['function', 'allow'],
      ['trait', 'Store'],
      ['function', 'main'],
      ['enum', 'Mode']
    ]);
  });

  it('finds functions in C by their shape at the start of a line: what a decompilation project is made of', () => {
    const text = [
      '#include "common.h"',
      '#define MAX_ACTORS 64',
      'typedef struct Actor {',
      '    s32 id;',
      '} Actor;',
      'static s32 func_80012AB0(Actor* actor, s32 arg1) {',
      '    if (actor->id > 0) {',
      '        return func_80012C00(actor);',
      '    }',
      '    return arg1;',
      '}',
      'void Actor_Update(Actor* this, PlayState* play)',
      '{',
      '}',
      's32 func_80012C00(Actor* actor);'
    ].join('\n');
    expect(names(text, 'actor.c')).toEqual([
      ['macro', 'MAX_ACTORS'],
      ['struct', 'Actor'],
      ['function', 'func_80012AB0'],
      ['function', 'Actor_Update']
    ]);
  });
});

describe('telling a definition from a use', () => {
  it('matches the line that defines a name, in the languages it knows', () => {
    const defines = (line: string, name: string): boolean => definitionRegex(name).test(line);
    expect(defines('export function createMission(sessionId: string) {', 'createMission')).toBe(true);
    expect(defines('export const createMission = (id: string) => {', 'createMission')).toBe(true);
    expect(defines('  async load(id: string): Promise<T> {', 'load')).toBe(true);
    expect(defines('class Limiter(Base):', 'Limiter')).toBe(true);
    expect(defines('    def allow(self, key):', 'allow')).toBe(true);
    expect(defines('func (b *Bucket) Allow() bool {', 'Allow')).toBe(true);
    expect(defines('pub async fn allow(&self) -> bool {', 'allow')).toBe(true);
    expect(defines('static s32 func_80012AB0(Actor* actor, s32 arg1) {', 'func_80012AB0')).toBe(true);
    expect(defines('#define MAX_ACTORS 64', 'MAX_ACTORS')).toBe(true);
    // Uses, not definitions.
    expect(defines('  const m = createMission(id, input);', 'createMission')).toBe(false);
    expect(defines('        return func_80012C00(actor);', 'func_80012C00')).toBe(false);
    expect(defines("import { createMission } from './mission';", 'createMission')).toBe(false);
    expect(defines('  if (load(id)) {', 'load')).toBe(false);
    // A longer name that contains it is another symbol.
    expect(defines('export function createMissionBrief() {', 'createMission')).toBe(false);
  });

  it('treats a name with characters special to patterns as plain text', () => {
    expect(definitionRegex('$store').test('const $store = writable(0);')).toBe(true);
    expect(() => definitionRegex('a.b(c')).not.toThrow();
  });
});

describe('following imports', () => {
  it('reads what a line imports, in JavaScript, Python, Go, Rust and C', () => {
    expect(importSpecifiers("import { a } from './mission';", 'js')).toEqual(['./mission']);
    expect(importSpecifiers("export * from '@shared/schemas/missions';", 'js')).toEqual(['@shared/schemas/missions']);
    expect(importSpecifiers("const fs = require('node:fs'); const x = await import('../x.js');", 'js')).toEqual(['node:fs', '../x.js']);
    expect(importSpecifiers('from app.limiter import Bucket', 'python')).toEqual(['app.limiter']);
    expect(importSpecifiers('import app.limiter as l, os', 'python')).toEqual(['app.limiter', 'os']);
    expect(importSpecifiers('\t"example.com/shop/limiter"', 'go')).toEqual(['example.com/shop/limiter']);
    expect(importSpecifiers('use crate::limiter::Bucket;', 'rust')).toEqual(['crate::limiter::Bucket']);
    expect(importSpecifiers('#include "actor.h"', 'c')).toEqual(['actor.h']);
    expect(importSpecifiers('const x = 1;', 'js')).toEqual([]);
  });

  it('resolves a JavaScript import to the file it means: relative, with or without an extension, an index file, or an alias', () => {
    const files = new Set(['src/agent/mission.ts', 'src/agent/index.ts', 'src/shared/schemas/missions.ts', 'src/ui/Bar.tsx']);
    const exists = (p: string): boolean => files.has(p);
    const aliases = [{ prefix: '@shared/', target: 'src/shared/' }];
    expect(resolveSpecifier('./mission', 'src/agent/session.ts', exists, aliases)).toBe('src/agent/mission.ts');
    expect(resolveSpecifier('../agent', 'src/ui/Bar.tsx', exists, aliases)).toBe('src/agent/index.ts');
    expect(resolveSpecifier('./mission.js', 'src/agent/session.ts', exists, aliases)).toBe('src/agent/mission.ts');
    expect(resolveSpecifier('@shared/schemas/missions', 'src/ui/Bar.tsx', exists, aliases)).toBe('src/shared/schemas/missions.ts');
    expect(resolveSpecifier('react', 'src/ui/Bar.tsx', exists, aliases)).toBeNull();
    expect(resolveSpecifier('./missing', 'src/agent/session.ts', exists, aliases)).toBeNull();
  });
});

describe('reading the aliases a project sets up', () => {
  it('reads "paths" from a tsconfig with comments, trailing commas, and globs that look like comments', () => {
    const config = [
      '{',
      '  // the app',
      '  "compilerOptions": {',
      '    "baseUrl": ".", /* relative to here */',
      '    "paths": {',
      '      "@renderer/*": ["src/renderer/src/*"],',
      '      "@shared/*": ["src/shared/*"], // the last one',
      '    },',
      '  },',
      '  "include": ["src/renderer/src/**/*", "src/shared/**/*", "docs/http://example.com"],',
      '}'
    ].join('\n');
    expect(aliasesFrom(config)).toEqual([
      { prefix: '@renderer/', target: 'src/renderer/src/' },
      { prefix: '@shared/', target: 'src/shared/' }
    ]);
  });

  it('follows baseUrl, and ignores what it cannot use', () => {
    expect(aliasesFrom('{ "compilerOptions": { "baseUrl": "src", "paths": { "~/*": ["app/*"], "exact": ["lib/exact.ts"], "up/*": ["../../outside/*"] } } }')).toEqual([{ prefix: '~/', target: 'src/app/' }]);
    expect(aliasesFrom('not json')).toEqual([]);
    expect(aliasesFrom('{ "compilerOptions": {} }')).toEqual([]);
  });
});

describe('finding the tests for a file', () => {
  it('knows a test file by its name or its folder', () => {
    expect(['src/a.test.ts', 'src/a.spec.tsx', 'tests/unit/a.ts', 'pkg/a_test.go', 'tests/test_a.py', 'src/__tests__/a.js', 'spec/a_spec.rb', 'src/ATest.java'].map(isTestFile)).toEqual(Array.from({ length: 8 }, () => true));
    expect(['src/a.ts', 'src/testing.ts', 'src/contest.py', 'latest/a.go'].map(isTestFile)).toEqual([false, false, false, false]);
  });

  it('looks for the names a test of a file usually has', () => {
    expect(testNameGlobs('src/agent/mission.ts')).toEqual(expect.arrayContaining(['**/mission.test.*', '**/mission.spec.*', '**/test_mission.*', '**/mission_test.*', '**/missionTest.*', '**/missionTests.*', '**/mission_spec.*']));
  });
});

describe('the Symbols tool', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    };
    write('tsconfig.json', '{\n  // paths for the app\n  "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["src/shared/*"], } },\n  "include": ["src/**/*", "tests/**/*"]\n}\n');
    write('src/shared/limits.ts', 'export const LIMIT = 60;\nexport function allow(count: number): boolean {\n  return count < LIMIT;\n}\n');
    write('src/api/routes.ts', "import { allow } from '@shared/limits';\nexport function handle(count: number): number {\n  return allow(count) ? 200 : 429;\n}\n");
    write('src/api/admin.ts', "import { allow, LIMIT } from '../shared/limits';\nexport const adminAllowed = (n: number): boolean => allow(n * 2) || n < LIMIT;\n");
    write('src/api/other.ts', "import { something } from './limits-of-growth';\nexport const allowance = 3;\n");
    write('tests/limits.test.ts', "import { allow } from '../src/shared/limits';\ntest('allows under the limit', () => expect(allow(1)).toBe(true));\n");
    write('tests/routes.test.ts', "import { handle } from '../src/api/routes';\ntest('handles', () => expect(handle(1)).toBe(200));\n");
    write('node_modules/pkg/index.js', 'function allow() {}\n');
    write('.gitignore', 'node_modules\n');
  });
  afterEach(() => removeDir(dir));

  const run = async (input: Parameters<typeof symbolsTool.execute>[0]): Promise<string> => {
    const result = await symbolsTool.execute(input, makeToolContext(dir));
    return textOf(result.content);
  };

  it('outlines a file: every definition with its line', async () => {
    const text = await run({ action: 'outline', path: 'src/shared/limits.ts' });
    expect(text).toContain('src/shared/limits.ts');
    expect(text).toContain('1: export const LIMIT = 60;');
    expect(text).toContain('2: export function allow(count: number): boolean {');
    expect(text).toMatch(/2 definitions/);
  });

  it('finds where a name is defined, and nowhere it is only used', async () => {
    const text = await run({ action: 'definition', name: 'allow' });
    expect(text).toContain('src/shared/limits.ts:2');
    expect(text).not.toContain('routes.ts');
    expect(text).not.toContain('allowance');
    // Ignored folders stay out of it.
    expect(text).not.toContain('node_modules');
  });

  it('lists the uses of a name by file, definition first, tests marked, whole words only', async () => {
    const text = await run({ action: 'references', name: 'allow' });
    expect(text).toMatch(/Defined in src\/shared\/limits\.ts:2/);
    expect(text).toContain('src/api/routes.ts');
    expect(text).toContain('src/api/admin.ts');
    expect(text).toMatch(/tests\/limits\.test\.ts \(test\)/);
    expect(text).not.toContain('other.ts');
    expect(text).toMatch(/3 files/);
  });

  it('finds what imports a file: by relative path and through a tsconfig alias, and not a file that merely has a similar name', async () => {
    const text = await run({ action: 'importers', path: 'src/shared/limits.ts' });
    expect(text).toContain('src/api/routes.ts');
    expect(text).toContain('src/api/admin.ts');
    expect(text).toContain('tests/limits.test.ts');
    expect(text).not.toContain('other.ts');
    expect(text).toMatch(/3 files import/);
  });

  it('finds the tests of a file: those named after it and those that import it', async () => {
    const text = await run({ action: 'tests', path: 'src/shared/limits.ts' });
    expect(text).toContain('tests/limits.test.ts');
    expect(text).not.toContain('routes.test.ts');
    const routes = await run({ action: 'tests', path: 'src/api/routes.ts' });
    expect(routes).toContain('tests/routes.test.ts');
  });

  it('says so plainly when there is nothing to find, or the request is incomplete', async () => {
    expect(await run({ action: 'definition', name: 'nothingCalledThis' })).toMatch(/No definition of nothingCalledThis/);
    expect(await run({ action: 'tests', path: 'src/api/other.ts' })).toMatch(/No tests found/);
    const missing = await symbolsTool.execute({ action: 'outline' }, makeToolContext(dir));
    expect(missing.isError).toBe(true);
    const noName = await symbolsTool.execute({ action: 'references' }, makeToolContext(dir));
    expect(noName.isError).toBe(true);
    const gone = await symbolsTool.execute({ action: 'outline', path: 'src/nope.ts' }, makeToolContext(dir));
    expect(gone.isError).toBe(true);
  });

  it('only reads: it asks for read access to the folder it searches', async () => {
    expect(symbolsTool.permissionClass).toBe('read');
    const described = await symbolsTool.describe({ action: 'references', name: 'allow' }, { cwd: dir, projectRoot: dir, platform: process.platform });
    expect(described.reads).toEqual([dir]);
    expect(described.writes).toBeUndefined();
  });
});
