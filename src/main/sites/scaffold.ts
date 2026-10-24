import fs from 'node:fs';
import path from 'node:path';
import { makeDirSync } from '../files/makeDir';

/**
 * The packages a TypeScript site starts with, at exact versions: the same starter installs the same
 * packages next month. TypeScript is the version Graft's own language server runs, so an edit to a
 * site is checked with the compiler that builds it. A release of Graft moves these forward together,
 * after the starter has been installed and built with them (tests/unit/sites.live.test.ts).
 */
export const SITE_PACKAGES = {
  dependencies: { react: '19.3.0', 'react-dom': '19.3.0' },
  devDependencies: {
    '@types/react': '19.3.0',
    '@types/react-dom': '19.3.0',
    '@vitejs/plugin-react': '6.1.2',
    typescript: '5.9.3',
    vite: '8.3.4'
  }
} as const;

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The files a TypeScript site starts from, by their place in its folder: a React project built
 * with Vite, strict TypeScript, styles as tokens and CSS modules. It builds as it stands, so the
 * first `npm run build` already puts a page in dist; the agent replaces the page, not the set-up.
 */
export function siteScaffold(name: string, slug: string): Record<string, string> {
  return {
    'package.json': json({
      name: slug,
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: { dev: 'vite', build: 'tsc --noEmit && vite build', typecheck: 'tsc --noEmit', preview: 'vite preview' },
      dependencies: SITE_PACKAGES.dependencies,
      devDependencies: SITE_PACKAGES.devDependencies
    }),
    'tsconfig.json': json({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        strict: true,
        noUncheckedIndexedAccess: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
        isolatedModules: true,
        verbatimModuleSyntax: true,
        skipLibCheck: true,
        noEmit: true
      },
      include: ['src', 'vite.config.ts']
    }),
    'vite.config.ts': [
      "import react from '@vitejs/plugin-react';",
      "import { defineConfig } from 'vite';",
      '',
      "// `base: './'` keeps every address in the built site relative, so the dist folder works wherever it is put.",
      'export default defineConfig({',
      "  base: './',",
      '  plugins: [react()]',
      '});',
      ''
    ].join('\n'),
    'index.html': [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      `    <title>${escapeHtml(name)}</title>`,
      '  </head>',
      '  <body>',
      '    <div id="root"></div>',
      '    <script type="module" src="/src/main.tsx"></script>',
      '  </body>',
      '</html>',
      ''
    ].join('\n'),
    'src/main.tsx': [
      "import { StrictMode } from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "import { App } from './App';",
      "import './styles/global.css';",
      '',
      "const root = document.getElementById('root');",
      "if (!root) throw new Error('The page has no #root element to draw the site in.');",
      '',
      'createRoot(root).render(',
      '  <StrictMode>',
      '    <App />',
      '  </StrictMode>',
      ');',
      ''
    ].join('\n'),
    'src/App.tsx': [
      "import styles from './App.module.css';",
      '',
      `const NAME = ${JSON.stringify(name)};`,
      '',
      '/** The site. This starter page gives way to the real one. */',
      'export function App() {',
      '  return (',
      '    <main className={styles.page}>',
      '      <h1 className={styles.title}>{NAME}</h1>',
      '      <p className={styles.note}>This site is being built.</p>',
      '    </main>',
      '  );',
      '}',
      ''
    ].join('\n'),
    'src/App.module.css': [
      '.page {',
      '  min-height: 100vh;',
      '  display: grid;',
      '  place-content: center;',
      '  gap: var(--space-2);',
      '  padding: var(--space-4);',
      '  text-align: center;',
      '}',
      '',
      '.title {',
      '  margin: 0;',
      '  font-size: clamp(2rem, 6vw, 3rem);',
      '  letter-spacing: -0.02em;',
      '}',
      '',
      '.note {',
      '  margin: 0;',
      '  color: var(--color-muted);',
      '}',
      ''
    ].join('\n'),
    'src/styles/tokens.css': [
      '/* The design in one place: colours, type, spacing. Components use these, never values of their own. */',
      ':root {',
      '  color-scheme: light dark;',
      '  --color-bg: #f6f4ee;',
      '  --color-text: #1f2420;',
      '  --color-muted: #5d6858;',
      '  --font-text: system-ui, sans-serif;',
      '  --space-1: 0.25rem;',
      '  --space-2: 0.5rem;',
      '  --space-3: 1rem;',
      '  --space-4: 1.5rem;',
      '}',
      '',
      '@media (prefers-color-scheme: dark) {',
      '  :root {',
      '    --color-bg: #151714;',
      '    --color-text: #e9eee5;',
      '    --color-muted: #a8b3a2;',
      '  }',
      '}',
      ''
    ].join('\n'),
    'src/styles/global.css': [
      "@import './tokens.css';",
      '',
      '*,',
      '*::before,',
      '*::after {',
      '  box-sizing: border-box;',
      '}',
      '',
      'body {',
      '  margin: 0;',
      '  font: 1rem/1.5 var(--font-text);',
      '  background: var(--color-bg);',
      '  color: var(--color-text);',
      '}',
      ''
    ].join('\n'),
    'src/vite-env.d.ts': '/// <reference types="vite/client" />\n',
    '.gitignore': ['node_modules', 'dist', '*.local', ''].join('\n'),
    'README.md': [
      `# ${name.replace(/[\r\n]+/g, ' ')}`,
      '',
      'A website built with React, TypeScript and Vite.',
      '',
      '```bash',
      'npm install        # once',
      'npm run dev        # work on it, with the page updating as you type',
      'npm run build      # type-check, then build the site into dist/',
      'npm run typecheck  # the type check alone',
      '```',
      '',
      'To publish it, put the `dist` folder on any static host, or connect this folder to a host',
      'that builds for you: build command `npm run build`, output folder `dist`.',
      '',
      '- `src/components/` holds the parts of the pages, one component to a file with its styles beside it.',
      '- `src/styles/tokens.css` holds the colours, type and spacing everything else uses.',
      '- `public/` holds files the pages link by address, such as the favicon.',
      ''
    ].join('\n')
  };
}

/** Writes a starter into a site's folder. A file that is already there is left as it is. */
export function writeScaffold(folder: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(folder, ...relative.split('/'));
    if (fs.existsSync(target)) continue;
    makeDirSync(path.dirname(target));
    fs.writeFileSync(target, content);
  }
}
