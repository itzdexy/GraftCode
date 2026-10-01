#!/usr/bin/env node
/**
 * Renders Graft's application and tray icons from the mark geometry in
 * src/renderer/src/brand/Mark.tsx (an open "G" whose terminal sprouts a leaf).
 *
 *   build/icon.png        1024×1024 (macOS / Linux, electron-builder source)
 *   build/icon.ico        16–256 px, PNG-compressed entries (Windows exe + installer)
 *   resources/icons/tray.png, tray@2x.png   tray / notification-area icon
 *   resources/icons/app.png                 256×256 window icon (Linux)
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

// Keep in sync with MARK_ARC / MARK_LEAF in Mark.tsx (32×32 grid).
const ARC = 'M22.07 9.93 A10 10 0 1 0 25 17 H17';
const LEAF = 'M22.07 9.93 Q27.16 9.36 27.73 4.27 Q22.64 4.84 22.07 9.93 Z';

const TILE = '#171816';
const TILE_EDGE = '#2a2c27';
const STROKE = '#eae8e0';
const LEAF_FILL = '#7fbf6a';

/** App tile: rounded square, light "G", green leaf. Small sizes get a heavier stroke. */
function tileSvg(size) {
  const stroke = size <= 24 ? 4.4 : size <= 48 ? 3.8 : 3.2;
  const inset = size <= 32 ? 0 : 1.2;
  const radius = 7.2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect x="${inset}" y="${inset}" width="${32 - inset * 2}" height="${32 - inset * 2}" rx="${radius}" fill="${TILE}" stroke="${TILE_EDGE}" stroke-width="${size <= 32 ? 0 : 0.35}"/>
  <g transform="translate(16 16) scale(0.74) translate(-16 -16.5)">
    <path d="${ARC}" fill="none" stroke="${STROKE}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${LEAF}" fill="${LEAF_FILL}"/>
  </g>
</svg>`;
}

/** Tray: the bare mark in the leaf green, which reads on light and dark taskbars. */
function traySvg(size) {
  const stroke = size <= 16 ? 4.6 : 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <g transform="translate(16 16) scale(0.95) translate(-16 -16.5)">
    <path d="${ARC}" fill="none" stroke="${LEAF_FILL}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${LEAF}" fill="${LEAF_FILL}"/>
  </g>
</svg>`;
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
