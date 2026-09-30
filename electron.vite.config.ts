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
    resolve: {
      alias: { ...sharedAlias, '@renderer': resolve(__dirname, 'src/renderer/src') }
    },
    plugins: [react(), tailwindcss(), devCsp()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
});
