import path from 'node:path';

/**
 * What the Symbols tool knows about source code: how each language writes a
 * definition and an import, and how tests are named. It reads text with
 * patterns, not a compiler, so it is fast and works on a project that doesn't
 * build, and it can miss what is generated or built in unusual ways.
 */

export type Language = 'js' | 'python' | 'go' | 'rust' | 'java' | 'c' | 'ruby' | 'php' | 'swift';

const EXTENSIONS: Record<string, Language> = {
  ts: 'js',
  tsx: 'js',
  mts: 'js',
  cts: 'js',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  vue: 'js',
  svelte: 'js',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'java',
  kts: 'java',
  cs: 'java',
  scala: 'java',
  c: 'c',
  h: 'c',
  cc: 'c',
  cpp: 'c',
  cxx: 'c',
  hpp: 'c',
  hh: 'c',
  inc: 'c',
  m: 'c',
  mm: 'c',
  rb: 'ruby',
  php: 'php',
  swift: 'swift'
};

export const LANGUAGE_NAMES: Record<Language, string> = {
  js: 'JavaScript/TypeScript',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  java: 'Java, Kotlin or C#',
  c: 'C or C++',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift'
};

export function languageOf(file: string): Language | null {
  return EXTENSIONS[path.extname(file).slice(1).toLowerCase()] ?? null;
}

export interface Definition {
  /** 1-based. */
  line: number;
  kind: string;
  name: string;
  /** The line as written, trimmed. */
  text: string;
}

/** A pattern for a definition: the kind is fixed, or taken from a capture; the name is always the last capture. */
type Rule = [RegExp, string | null];

// Words that open a block the way a method does, but aren't one.
const NOT_A_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'else', 'do', 'try']);
const IDENT = '[A-Za-z_$][\\w$]*';

const RULES: Record<Language, Rule[]> = {
  js: [
    [new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?interface\\s+(${IDENT})`), 'interface'],
    [new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+(${IDENT})\\s*(?:<[^=]*>)?\\s*=`), 'type'],
    [new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${IDENT})`), 'enum'],
    [new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${IDENT})`), 'class'],
    [new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`), 'function'],
    // A function kept in a variable. Only at the start of a line: inside a function it is a detail, not a definition.
    [new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:\\([^)]*\\)|${IDENT})\\s*(?::[^=]+?)?=>`), 'function'],
    [new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})`), 'const'],
    [new RegExp(`^\\s+(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\\s+)*\\*?\\s*([A-Za-z_$#][\\w$]*)\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::\\s*[^{;]+)?\\{(?:\\s*\\})?\\s*$`), 'method']
  ],
  python: [
    [/^\s*class\s+(\w+)/, 'class'],
    [/^\s+(?:async\s+)?def\s+(\w+)\s*\(/, 'method'],
    [/^(?:async\s+)?def\s+(\w+)\s*\(/, 'function']
  ],
  go: [
    [/^func\s+\([^)]*\)\s*(\w+)\s*[([]/, 'method'],
    [/^func\s+(\w+)\s*[([]/, 'function'],
    [/^type\s+(\w+)\s+struct\b/, 'struct'],
    [/^type\s+(\w+)\s+interface\b/, 'interface'],
    [/^type\s+(\w+)\s/, 'type']
  ],
  rust: [
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/, 'function'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|mod|union)\s+(\w+)/, null],
    [/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?(\w+)/, 'impl'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?(\w+)\s*:/, 'const']
  ],
  java: [
    [/^\s*(?:(?:public|private|protected|internal|abstract|final|static|sealed|open|data|partial|inner)\s+)*(class|interface|enum|record|object|struct|trait)\s+(\w+)/, null],
    [/^\s*(?:(?:public|private|protected|internal|override|open|suspend|inline|abstract|final)\s+)*(?:fun|def)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/, 'function'],
    [/^\s+(?:(?:public|private|protected|internal|static|final|abstract|synchronized|override|virtual|async|sealed)\s+)+[\w<>[\],.?\s]+?\s+(\w+)\s*\([^;]*$/, 'method']
  ],
  c: [
    [/^\s*#\s*define\s+(\w+)/, 'macro'],
    [/^(?:typedef\s+)?(struct|union|enum|class)\s+(\w+)\s*(?:\{|:|$)/, null],
    // A function: at the start of a line, a type and then a name with its arguments, and no semicolon (that would only declare it).
    [/^(?!\s)(?:[\w*&:<>,~[\]]+\s+)+[*&]*([A-Za-z_~][\w:~]*)\s*\([^;]*$/, 'function']
  ],
  ruby: [
    [/^\s*(class|module)\s+([\w:]+)/, null],
    [/^\s*def\s+(?:self\.)?([\w?!=]+)/, 'method']
  ],
  php: [
    [/^\s*(?:abstract\s+|final\s+)?(class|interface|trait|enum)\s+(\w+)/, null],
    [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?(\w+)/, 'function']
  ],
  swift: [
    [/^\s*(?:(?:public|private|fileprivate|internal|open|final)\s+)*(class|struct|enum|protocol|extension|actor)\s+(\w+)/, null],
    [/^\s*(?:(?:public|private|fileprivate|internal|open|static|class|override|final|mutating|@\w+)\s+)*func\s+(\w+)/, 'function']
  ]
};

/** The definitions in a file's text, in the order they appear. Nothing for a language it doesn't know. */
export function outlineOf(text: string, language: Language | null): Definition[] {
  if (!language) return [];
  const rules = RULES[language];
  const out: Definition[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const [pattern, fixed] of rules) {
      const match = pattern.exec(line);
      if (!match) continue;
      const name = match.at(-1) ?? '';
      const kind = fixed ?? match[1] ?? 'definition';
      if (kind === 'method' && NOT_A_METHOD.has(name)) return;
      if (kind === 'function' && language === 'c' && NOT_A_METHOD.has(name)) return;
      out.push({ line: index + 1, kind, name, text: line.trim().slice(0, 160) });
      return;
    }
  });
  return out;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches a line that defines `name` (rather than uses it), across the languages above. */
export function definitionRegex(name: string): RegExp {
  const n = escapeRegex(name);
  const end = '(?![\\w$])';
  return new RegExp(
    [
      // Introduced by a keyword: function f, class C, def f, func (r) F, fn f, struct S, type T, #define M…
      `(?:^|[^\\w.$])(?:function\\s*\\*?|class|interface|type|enum|const|let|var|def|func(?:\\s+\\([^)]*\\))?|fn|fun|struct|union|trait|impl|mod|module|namespace|record|object|protocol|extension|typedef|#\\s*define)\\s+${n}${end}`,
      // A method: name(args) { with only modifiers before it.
      `^\\s+(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\\s+)*\\*?${n}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::\\s*[^{;]+)?\\{`,
      // A C-style function at the start of a line: a type, the name, its arguments, no semicolon.
      `^(?!\\s)(?:[\\w*&:<>,~\\[\\]]+\\s+)+[*&]*${n}\\s*\\([^;]*$`,
      // A property given a function: name: function… or name = (…) =>
      `(?:^|[\\s,{])${n}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|${IDENT}\\s*=>)`
    ].join('|')
  );
}

/** What a line of code imports: module paths as written. */
export function importSpecifiers(line: string, language: Language | null): string[] {
  const all = (pattern: RegExp): string[] => [...line.matchAll(pattern)].flatMap((m) => (m[1] ? [m[1]] : []));
  switch (language) {
    case 'js':
      return all(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g);
    case 'python': {
      const from = /^\s*from\s+([\w.]+)\s+import\b/.exec(line);
      if (from?.[1]) return [from[1]];
      const plain = /^\s*import\s+(.+)$/.exec(line);
      return plain?.[1] ? plain[1].split(',').flatMap((part) => /^\s*([\w.]+)/.exec(part)?.[1] ?? []) : [];
    }
    case 'go':
      return all(/^\s*(?:import\s+)?(?:[\w.]+\s+)?"([^"]+)"\s*$/g);
    case 'rust':
      return [...all(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/g), ...all(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g)];
    case 'c':
      return all(/^\s*#\s*(?:include|import)\s+["<]([^">]+)[">]/g);
    case 'java':
      return all(/^\s*(?:import|using)\s+(?:static\s+)?([\w.]+)/g);
    case 'ruby':
      return all(/\brequire(?:_relative)?\s*\(?\s*['"]([^'"]+)['"]/g);
    case 'php':
      return [...all(/^\s*use\s+([\w\\]+)/g), ...all(/\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g)];
    case 'swift':
      return all(/^\s*import\s+(\w+)/g);
    case null:
      return [];
  }
}

export interface PathAlias {
  /** What an import starts with, e.g. "@shared/". */
  prefix: string;
  /** The folder it stands for, relative to the project, e.g. "src/shared/". */
  target: string;
}

const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.d.ts', '.json', '.vue', '.svelte'];
// TypeScript projects that build to ES modules write "./x.js" for the file x.ts.
const WRITTEN_AS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

/**
 * The project file a JavaScript import means, or null for a package or a file
 * that isn't there. Paths are relative to the project, with forward slashes.
 */
export function resolveSpecifier(specifier: string, fromFile: string, exists: (file: string) => boolean, aliases: PathAlias[]): string | null {
  let base: string;
  if (specifier.startsWith('.')) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  } else {
    const alias = aliases.find((a) => specifier.startsWith(a.prefix));
    if (!alias) return null;
    base = path.posix.normalize(alias.target + specifier.slice(alias.prefix.length));
  }
  if (base.startsWith('..')) return null;
  const candidates = [base];
  const ext = path.posix.extname(base);
  for (const real of WRITTEN_AS[ext] ?? []) candidates.push(base.slice(0, -ext.length) + real);
  for (const e of JS_EXTENSIONS) candidates.push(base + e);
  for (const e of JS_EXTENSIONS) candidates.push(`${base}/index${e}`);
  return candidates.find(exists) ?? null;
}

/**
 * Walks JSON-like text outside its strings: `outside` decides what each
 * character there becomes and how far to move on. Strings are copied as they
 * are, so what looks like a comment inside one (the glob "src/**" + "/*") is
 * left alone.
 */
function outsideStrings(text: string, outside: (at: number) => { keep: string; next: number }): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, ++i);
      continue;
    }
    const step = outside(i);
    out += step.keep;
    i = step.next;
  }
  return out;
}

/** JSON as config files write it (comments, trailing commas) made plain JSON. */
function plainJson(text: string): string {
  const uncommented = outsideStrings(text, (i) => {
    if (text[i] === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      return { keep: '', next: end === -1 ? text.length : end };
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      return { keep: '', next: end === -1 ? text.length : end + 2 };
    }
    return { keep: text[i] ?? '', next: i + 1 };
  });
  return outsideStrings(uncommented, (i) => ({ keep: uncommented[i] === ',' && /^\s*[}\]]/.test(uncommented.slice(i + 1)) ? '' : (uncommented[i] ?? ''), next: i + 1 }));
}

/** Reads "paths" from the text of a tsconfig or jsconfig (JSON with comments and trailing commas). */
export function aliasesFrom(configText: string): PathAlias[] {
  let config: { compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
  try {
    config = JSON.parse(plainJson(configText)) as typeof config;
  } catch {
    return [];
  }
  const paths = config.compilerOptions?.paths;
  if (!paths || typeof paths !== 'object') return [];
  const baseUrl = typeof config.compilerOptions?.baseUrl === 'string' ? config.compilerOptions.baseUrl : '.';
  const out: PathAlias[] = [];
  for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
    const first: unknown = Array.isArray(targets) ? targets[0] : null;
    if (typeof first !== 'string' || !pattern.endsWith('/*') || !first.endsWith('/*')) continue;
    const target = path.posix.normalize(path.posix.join(baseUrl.replace(/\\/g, '/'), first.slice(0, -1)));
    if (target.startsWith('..')) continue;
    out.push({ prefix: pattern.slice(0, -1), target: target.endsWith('/') ? target : `${target}/` });
  }
  return out;
}

const TEST_FOLDER = /(^|\/)(tests?|__tests__|specs?|e2e)\//;
const TEST_NAME = /(\.(test|spec)\.[\w.]+|_test\.\w+|_spec\.rb|Tests?\.(java|kt|cs|swift))$/;

/** Whether a path (forward slashes) is a test by its name or its folder. */
export function isTestFile(file: string): boolean {
  const name = file.slice(file.lastIndexOf('/') + 1);
  return TEST_FOLDER.test(file) || TEST_NAME.test(name) || /^test_.*\.py$/.test(name);
}

/** The name a file is known by: its own, or its folder's when it is an index of one. */
export function moduleStem(file: string): string {
  const stem = path.posix.basename(file).replace(/\.d\.ts$/, '').replace(/\.[^.]+$/, '');
  const folder = path.posix.basename(path.posix.dirname(file));
  return ['index', '__init__', 'mod', 'main', 'lib'].includes(stem) && folder && folder !== '.' ? folder : stem;
}

/** The file names a test of `file` usually has, as globs. */
export function testNameGlobs(file: string): string[] {
  const stem = path.posix.basename(file).replace(/\.d\.ts$/, '').replace(/\.[^.]+$/, '');
  return [`**/${stem}.test.*`, `**/${stem}.spec.*`, `**/test_${stem}.*`, `**/${stem}_test.*`, `**/${stem}Test.*`, `**/${stem}Tests.*`, `**/${stem}_spec.*`];
}

/**
 * Whether an import written as `specifier` in a file of `language` means
 * `target` (a project path): "yes", "no", or "maybe" when only the name
 * agrees and the language's rules can't be checked from here.
 */
export function importsTarget(specifier: string, language: Language | null, fromFile: string, target: string, exists: (file: string) => boolean, aliases: PathAlias[]): 'yes' | 'no' | 'maybe' {
  const noExt = target.replace(/\.[^./]+$/, '');
  switch (language) {
    case 'js': {
      const resolved = resolveSpecifier(specifier, fromFile, exists, aliases);
      if (resolved !== null) return resolved === target ? 'yes' : 'no';
      // An alias this search doesn't know (a bundler's) that ends in the file's own path.
      return !specifier.startsWith('.') && specifier.includes('/') && noExt.endsWith(specifier.replace(/^[@~#]?[^/]*\//, '')) ? 'maybe' : 'no';
    }
    case 'python': {
      const asPath = specifier.replace(/^\.+/, '').replace(/\./g, '/');
      if (asPath.length === 0) return 'no';
      return noExt === asPath || noExt.endsWith(`/${asPath}`) || noExt === `${asPath}/__init__` || noExt.endsWith(`/${asPath}/__init__`) ? 'yes' : 'no';
    }
    case 'go': {
      const folder = path.posix.dirname(target);
      return folder !== '.' && (specifier === folder || specifier.endsWith(`/${folder}`) || folder.endsWith(`/${specifier.split('/').slice(-2).join('/')}`)) ? 'yes' : 'no';
    }
    case 'rust': {
      const modulePath = noExt.replace(/^src\//, '').replace(/\/mod$/, '').replace(/\//g, '::');
      return specifier === path.posix.basename(noExt) || specifier.replace(/^(crate|self|super)::/, '').startsWith(modulePath) ? 'yes' : 'no';
    }
    case 'c': {
      const direct = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
      return direct === target || target === specifier || target.endsWith(`/${specifier}`) ? 'yes' : 'no';
    }
    default:
      return specifier.includes(moduleStem(target)) ? 'maybe' : 'no';
  }
}
