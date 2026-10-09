import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const sharedAlias = { '@shared': resolve(__dirname, 'src/shared') };

/**
 * The production CSP lives in index.html. Vite's dev server needs an inline
 * React-refresh preamble and a websocket for HMR, so the policy is relaxed only
 * while serving; built output keeps the strict policy untouched.
 */
function devCsp(): Plugin {
  return {
    name: 'graft-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*");
    }
  };
}

/** Monaco 0.57 also embeds DOMPurify 3.4.15: an npm override alone cannot fix that copy. */
function patchedEditorSanitizer(): Plugin {
  return {
    name: 'graft-patched-editor-sanitizer',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './dompurify/dompurify.js' && importer?.replaceAll('\\', '/').endsWith('/monaco-editor/esm/vs/base/browser/domSanitize.js')) {
        return resolve(__dirname, 'node_modules/dompurify/dist/purify.es.mjs');
      }
      return null;
    }
  };
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: {
      externalizeDeps: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      // Sandboxed preloads cannot require node_modules, so everything is bundled.
      externalizeDeps: false,
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // Keep Monaco's embedded sanitizer visible to the scoped replacement in dev too.
    optimizeDeps: { exclude: ['monaco-editor'] },
    resolve: {
      alias: { ...sharedAlias, '@renderer': resolve(__dirname, 'src/renderer/src') }
    },
    plugins: [react(), tailwindcss(), devCsp(), patchedEditorSanitizer()],
    build: {
      // Smaller to load and parse at startup; stack traces in logs still name the files.
      minify: 'esbuild',
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
});
