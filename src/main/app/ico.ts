import zlib from 'node:zlib';

/**
 * Windows icon (.ico) files, which Electron's nativeImage can't read from
 * memory. Picks the image closest to the wanted size and returns it as PNG:
 * PNG entries as stored, bitmap entries (1, 4, 8, 24 or 32 bits per pixel)
 * converted. The bytes come from arbitrary websites, so every offset and size
 * is checked before it is read.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isIco(buffer: Buffer): boolean {
  return buffer.length >= 22 && buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1 && buffer.readUInt16LE(4) > 0;
}

export function icoToPng(buffer: Buffer, want = 32): Buffer | null {
  if (!isIco(buffer)) return null;
  const entries: Array<{ size: number; bits: number; data: Buffer }> = [];
  for (let i = 0; i < Math.min(buffer.readUInt16LE(4), 64); i++) {
    const at = 6 + i * 16;
    if (at + 16 > buffer.length) break;
    const length = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    if (length < 8 || offset + length > buffer.length) continue;
    // A stored width of 0 means 256.
    entries.push({ size: buffer[at] || 256, bits: buffer.readUInt16LE(at + 6), data: buffer.subarray(offset, offset + length) });
  }
  // The smallest image at least `want` wide, else the largest; more colors first.
  const rank = (size: number): number => (size >= want ? size : 1000 - size);
  entries.sort((a, b) => rank(a.size) - rank(b.size) || b.bits - a.bits);
  for (const entry of entries) {
    const png = entry.data.subarray(0, 8).equals(PNG_SIGNATURE) ? entry.data : bitmapToPng(entry.data);
    if (png) return png;
  }
  return null;
}

/** A bitmap icon entry: a BITMAPINFOHEADER, a palette at 8 bits or fewer, the pixels, then the transparency (AND) mask. */
function bitmapToPng(dib: Buffer): Buffer | null {
  if (dib.length < 40) return null;
  const headerSize = dib.readUInt32LE(0);
  const width = dib.readInt32LE(4);
  // The stored height covers the pixels and the mask; negative means rows run top-down.
  const stored = dib.readInt32LE(8);
  const height = Math.abs(stored) / 2;
  const bits = dib.readUInt16LE(14);
  if (headerSize < 40 || headerSize > dib.length || dib.readUInt32LE(16) !== 0) return null;
  if (width < 1 || width > 256 || !Number.isInteger(height) || height < 1 || height > 256 || ![1, 4, 8, 24, 32].includes(bits)) return null;
  const colors = bits <= 8 ? dib.readUInt32LE(32) || 2 ** bits : 0;
  if (colors > 256) return null;
  const palette = headerSize;
  const pixels = palette + colors * 4;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const mask = pixels + stride * height;
  const maskStride = Math.ceil(width / 32) * 4;
  if (mask > dib.length) return null;
  const hasMask = mask + maskStride * height <= dib.length;
  const row = (start: number, rowStride: number, y: number): number => start + (stored > 0 ? height - 1 - y : y) * rowStride;

  const rgba = Buffer.alloc(width * height * 4);
  let alpha = false;
  for (let y = 0; y < height; y++) {
    const line = row(pixels, stride, y);
    for (let x = 0; x < width; x++) {
      let source: number;
      if (bits === 32) {
        source = line + x * 4;
        if (dib[source + 3] !== 0) alpha = true;
      } else if (bits === 24) {
        source = line + x * 3;
      } else {
        const bit = x * bits;
        const index = ((dib[line + (bit >> 3)] ?? 0) >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
        source = index < colors ? palette + index * 4 : -1;
      }
      const out = (y * width + x) * 4;
      if (source >= 0) {
        rgba[out] = dib[source + 2] ?? 0;
        rgba[out + 1] = dib[source + 1] ?? 0;
        rgba[out + 2] = dib[source] ?? 0;
      }
      rgba[out + 3] = bits === 32 ? (dib[source + 3] ?? 0) : 255;
    }
  }
  // Below 32 bits, or when the alpha channel is empty, the mask decides; without a mask the icon is opaque.
  if (bits < 32 || !alpha) {
    for (let y = 0; y < height; y++) {
      const line = row(mask, maskStride, y);
      for (let x = 0; x < width; x++) {
        const transparent = hasMask && ((dib[line + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
        rgba[(y * width + x) * 4 + 3] = transparent ? 0 : 255;
      }
    }
  }
  return encodePng(width, height, rgba);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const lineBytes = width * 4;
  const scanlines = Buffer.alloc((lineBytes + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(scanlines, y * (lineBytes + 1) + 1, y * lineBytes, (y + 1) * lineBytes);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, deflate, standard filtering, not interlaced
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
