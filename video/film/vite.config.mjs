// Builds Graft's renderer as a plain web page for the film (npm run app, in video/). The page
// gets its preload bridge from film/app/*.js, which the film script injects, so nothing is
// injected here.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

export default defineConfig({
  root: resolve(repo, 'src/renderer'),
  base: './',
  cacheDir: resolve(here, '..', '.cache', 'vite'),
  resolve: { alias: { '@shared': resolve(repo, 'src/shared'), '@renderer': resolve(repo, 'src/renderer/src') } },
  plugins: [react(), tailwindcss()],
  build: { outDir: resolve(here, '..', '.cache', 'app'), emptyOutDir: true }
});
