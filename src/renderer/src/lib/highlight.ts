import type { HighlighterCore, LanguageInput, ThemeRegistrationAny } from 'shiki/core';
import { DEFAULT_CODE_THEMES, type CodeTheme, type CodeThemePair } from '@shared/codeThemes';

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

/** Each theme is loaded the first time code is shown in it. */
const THEMES: Record<CodeTheme, () => Promise<{ default: ThemeRegistrationAny }>> = {
  'vitesse-dark': () => import('shiki/themes/vitesse-dark.mjs'),
  'github-dark': () => import('shiki/themes/github-dark.mjs'),
  'catppuccin-mocha': () => import('shiki/themes/catppuccin-mocha.mjs'),
  'night-owl': () => import('shiki/themes/night-owl.mjs'),
  'one-dark-pro': () => import('shiki/themes/one-dark-pro.mjs'),
  'tokyo-night': () => import('shiki/themes/tokyo-night.mjs'),
  'dracula': () => import('shiki/themes/dracula.mjs'),
  'rose-pine': () => import('shiki/themes/rose-pine.mjs'),
  'everforest-dark': () => import('shiki/themes/everforest-dark.mjs'),
  'gruvbox-dark-medium': () => import('shiki/themes/gruvbox-dark-medium.mjs'),
  'nord': () => import('shiki/themes/nord.mjs'),
  'monokai': () => import('shiki/themes/monokai.mjs'),
  'vitesse-light': () => import('shiki/themes/vitesse-light.mjs'),
  'github-light': () => import('shiki/themes/github-light.mjs'),
  'catppuccin-latte': () => import('shiki/themes/catppuccin-latte.mjs'),
  'night-owl-light': () => import('shiki/themes/night-owl-light.mjs'),
  'one-light': () => import('shiki/themes/one-light.mjs'),
  'rose-pine-dawn': () => import('shiki/themes/rose-pine-dawn.mjs'),
  'everforest-light': () => import('shiki/themes/everforest-light.mjs'),
  'gruvbox-light-medium': () => import('shiki/themes/gruvbox-light-medium.mjs'),
  'solarized-light': () => import('shiki/themes/solarized-light.mjs'),
  'min-light': () => import('shiki/themes/min-light.mjs')
};

let highlighter: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')]);
    return createHighlighterCore({
      themes: [THEMES[DEFAULT_CODE_THEMES.dark](), THEMES[DEFAULT_CODE_THEMES.light]()],
      langs: [],
      engine: createJavaScriptRegexEngine()
    });
  })();
  return highlighter;
}

const cache = new Map<string, Token[][]>();
const CACHE_LIMIT = 300;
const MAX_HIGHLIGHT_CHARS = 200_000;

async function withThemes(h: HighlighterCore, themes: CodeTheme[]): Promise<void> {
  const loaded = h.getLoadedThemes();
  for (const theme of themes) if (!loaded.includes(theme)) await h.loadTheme((await THEMES[theme]()).default);
}

/**
 * Tokenized lines for dual-theme rendering, or null when the language is
 * unsupported or the text too large. `themes` is the pair Settings chose.
 */
export async function highlightLines(code: string, language: string | null, themes: CodeThemePair = DEFAULT_CODE_THEMES): Promise<Token[][] | null> {
  const id = resolveLanguage(language);
  if (!id || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const key = `${themes.dark}\u0000${themes.light}\u0000${id}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const h = await getHighlighter();
  await withThemes(h, [themes.dark, themes.light]);
  if (!h.getLoadedLanguages().includes(id)) {
    const loader = LANGS[id];
    if (!loader) return null;
    await h.loadLanguage((await loader()).default);
  }
  const result = h.codeToTokens(code, { lang: id, themes: { dark: themes.dark, light: themes.light }, defaultColor: false });
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

/** A piece of code as one theme alone draws it, with the theme's own background: what Settings shows for a theme. */
export interface ThemePreview {
  background: string;
  foreground: string;
  lines: Array<Array<{ content: string; color: string | undefined; italic: boolean }>>;
}

export async function themePreview(code: string, language: string, theme: CodeTheme): Promise<ThemePreview | null> {
  const id = resolveLanguage(language);
  if (!id) return null;
  const h = await getHighlighter();
  await withThemes(h, [theme]);
  if (!h.getLoadedLanguages().includes(id)) {
    const loader = LANGS[id];
    if (!loader) return null;
    await h.loadLanguage((await loader()).default);
  }
  const result = h.codeToTokens(code, { lang: id, theme });
  return {
    background: result.bg ?? 'transparent',
    foreground: result.fg ?? 'inherit',
    // fontStyle is a bit set; 1 is italic.
    lines: result.tokens.map((line) => line.map((t) => ({ content: t.content, color: t.color, italic: ((t.fontStyle ?? 0) & 1) === 1 })))
  };
}
