import type { HighlighterCore, LanguageInput } from 'shiki/core';

/**
 * Syntax highlighting with shiki's JavaScript regex engine (no WebAssembly,
 * so the strict CSP stays intact). The highlighter and each grammar load on
 * first use; results are cached.
 */

type Loader = () => Promise<{ default: LanguageInput }>;

const LANGS: Record<string, Loader> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  bat: () => import('shiki/langs/bat.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs')
};

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  ps1: 'powershell',
  pwsh: 'powershell',
  cmd: 'bat',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  kt: 'kotlin',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  h: 'c',
  cs: 'csharp',
  rb: 'ruby',
  yml: 'yaml',
  md: 'markdown',
  htm: 'html',
  svg: 'xml',
  docker: 'dockerfile',
  patch: 'diff'
};

/** Grammar id for a fence label or file extension; null when unsupported. */
export function resolveLanguage(label: string | null | undefined): string | null {
  if (!label) return null;
  const key = label.trim().toLowerCase();
  const id = ALIASES[key] ?? key;
  return id in LANGS ? id : null;
}

export function languageForPath(filePath: string): string | null {
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'dockerfile';
  const ext = name.includes('.') ? name.split('.').pop() : null;
  return resolveLanguage(ext);
}

export interface Token {
  content: string;
  /** CSS custom properties --shiki-dark / --shiki-light (resolved per theme in globals.css). */
  style: Record<string, string>;
}

let highlighter: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')]);
    return createHighlighterCore({
      themes: [import('shiki/themes/vitesse-dark.mjs'), import('shiki/themes/vitesse-light.mjs')],
      langs: [],
      engine: createJavaScriptRegexEngine()
    });
  })();
  return highlighter;
}

const cache = new Map<string, Token[][]>();
const CACHE_LIMIT = 300;
const MAX_HIGHLIGHT_CHARS = 200_000;

/** Tokenized lines for dual-theme rendering, or null when the language is unsupported or the text too large. */
export async function highlightLines(code: string, language: string | null): Promise<Token[][] | null> {
  const id = resolveLanguage(language);
  if (!id || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const key = `${id}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const h = await getHighlighter();
  if (!h.getLoadedLanguages().includes(id)) {
    const loader = LANGS[id];
    if (!loader) return null;
    await h.loadLanguage((await loader()).default);
  }
  const result = h.codeToTokens(code, { lang: id, themes: { dark: 'vitesse-dark', light: 'vitesse-light' }, defaultColor: false });
  const lines = result.tokens.map((line) =>
    line.map((t) => ({ content: t.content, style: t.htmlStyle ?? {} }))
  );
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, lines);
  return lines;
}
