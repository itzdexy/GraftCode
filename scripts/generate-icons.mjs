#!/usr/bin/env node
/**
 * Renders Graft's application and tray icons from Scion, the pixel mascot in
 * src/renderer/src/brand/scion.json (the same sprite Mascot.tsx and Mark.tsx draw).
 *
 *   build/icon.png        1024×1024 (macOS / Linux, electron-builder source)
 *   build/icon.ico        16–256 px, PNG-compressed entries (Windows exe + installer)
 *   resources/icons/tray.png, tray@2x.png   tray / notification-area icon
 *   resources/icons/app.png                 256×256 window icon
 *
 * Every size uses a whole number of pixels per cell, so the art stays crisp.
 *
 * Usage: npm run icons
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(root, 'build');
const ICONS = path.join(root, 'resources', 'icons');
const SCION = JSON.parse(fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'brand', 'scion.json'), 'utf8'));
const COLUMNS = SCION.sprite[0].length;
const ROWS = SCION.sprite.length;

const TILE = '#171816';
const TILE_EDGE = '#2a2c27';

/** Scion as crisp rects: `cell` pixels per sprite cell, top-left at (x, y). */
function art(cell, x, y) {
  const rects = SCION.sprite
    .flatMap((row, cy) =>
      [...row].map((key, cx) => {
        const fill = SCION.fills[key];
        return fill ? `<rect x="${x + cx * cell}" y="${y + cy * cell}" width="${cell}" height="${cell}" fill="${SCION.iconColors[fill]}"/>` : '';
      })
    )
    .join('');
  return `<g shape-rendering="crispEdges">${rects}</g>`;
}

/** Largest whole cell size that keeps the art within `share` of the icon's width. */
function cellFor(size, share) {
  return Math.max(1, Math.floor((size * share) / COLUMNS));
}

/** App tile: dark rounded square with Scion centered. */
function tileSvg(size) {
  const cell = cellFor(size, 0.72);
  const x = Math.floor((size - COLUMNS * cell) / 2);
  const y = Math.floor((size - ROWS * cell) / 2);
  const inset = size <= 32 ? 0 : size * 0.0375;
  const edge = size <= 32 ? 0 : size * 0.011;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="${inset}" y="${inset}" width="${size - inset * 2}" height="${size - inset * 2}" rx="${size * 0.225}" fill="${TILE}" stroke="${TILE_EDGE}" stroke-width="${edge}"/>
  ${art(cell, x, y)}
</svg>`;
}

/** Tray: Scion alone, which reads on light and dark taskbars. */
function traySvg(size) {
  const cell = cellFor(size, 1);
  const x = Math.floor((size - COLUMNS * cell) / 2);
  const y = Math.floor((size - ROWS * cell) / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${art(cell, x, y)}</svg>`;
}

async function png(svg) {
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

/** ICO container with PNG-compressed images (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

async function main() {
  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(ICONS, { recursive: true });

  fs.writeFileSync(path.join(BUILD, 'icon.png'), await png(tileSvg(1024)));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = [];
  for (const size of sizes) images.push({ size, data: await png(tileSvg(size)) });
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico(images));

  fs.writeFileSync(path.join(ICONS, 'app.png'), await png(tileSvg(256)));
  fs.writeFileSync(path.join(ICONS, 'tray.png'), await png(traySvg(16)));
  fs.writeFileSync(path.join(ICONS, 'tray@2x.png'), await png(traySvg(32)));
  console.log(`Wrote build/icon.png, build/icon.ico (${sizes.join(', ')}), resources/icons/{app,tray,tray@2x}.png`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
