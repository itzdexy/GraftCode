#!/usr/bin/env node
/**
 * Copies the fonts that previews of pages are given into resources/fonts,
 * from the @fontsource packages in node_modules (all under the SIL Open Font
 * License), with their licences in one OFL.txt.
 *
 * A preview has no network, and pages such as the ones the diagram-design
 * skill writes ask a font service for Geist, Geist Mono and Instrument
 * Serif. The preview server adds these files to a page that names them (see
 * src/main/artifacts/previewExtras.ts). Latin only: other scripts fall back
 * to the computer's own fonts.
 *
 * Usage: npm run fonts   (after changing a font package's version)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'resources', 'fonts');

/** [family, package, file in the package, name here] */
const FONTS = [
  ['Geist', '@fontsource-variable/geist', 'geist-latin-wght-normal.woff2', 'Geist.woff2'],
  ['Geist Mono', '@fontsource-variable/geist-mono', 'geist-mono-latin-wght-normal.woff2', 'GeistMono.woff2'],
  ['Instrument Serif', '@fontsource/instrument-serif', 'instrument-serif-latin-400-normal.woff2', 'InstrumentSerif-Regular.woff2'],
  ['Instrument Serif', '@fontsource/instrument-serif', 'instrument-serif-latin-400-italic.woff2', 'InstrumentSerif-Italic.woff2']
];

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`${path.relative(root, file)} is missing. Run npm install first.`);
  return fs.readFileSync(file);
}

try {
  fs.mkdirSync(OUT, { recursive: true });
  const licences = new Map();
  for (const [family, pkg, source, name] of FONTS) {
    const folder = path.join(root, 'node_modules', ...pkg.split('/'));
    fs.writeFileSync(path.join(OUT, name), read(path.join(folder, 'files', source)));
    if (!licences.has(family)) {
      const version = JSON.parse(read(path.join(folder, 'package.json')).toString('utf8')).version;
      licences.set(family, `${family} (${pkg} ${version})\n${'='.repeat(60)}\n\n${read(path.join(folder, 'LICENSE')).toString('utf8').trim()}\n`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'OFL.txt'), [...licences.values()].join('\n\n'));
  console.log(`${FONTS.length} fonts and OFL.txt in ${path.relative(root, OUT)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
