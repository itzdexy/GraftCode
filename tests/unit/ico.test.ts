import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { icoToPng, isIco } from '../../src/main/app/ico';

/** An .ico file holding the given images (each a PNG file or a bitmap entry). */
function ico(images: Array<{ size: number; bits: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, i) => {
    const at = 6 + i * 16;
    header[at] = image.size % 256;
    header[at + 1] = image.size % 256;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(image.bits, at + 6);
    header.writeUInt32LE(image.data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

/** A bitmap entry: header, palette, bottom-up pixel rows, then the AND mask (1 = transparent). */
function bitmap(width: number, height: number, bits: number, rows: Buffer[], mask: number[][], palette: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(bits, 14);
  const maskStride = Math.ceil(width / 32) * 4;
  const maskRows = mask.map((bitsOfRow) => {
    const line = Buffer.alloc(maskStride);
    bitsOfRow.forEach((bit, x) => {
      if (bit) line[x >> 3] = (line[x >> 3] ?? 0) | (0x80 >> (x & 7));
    });
    return line;
  });
  return Buffer.concat([header, palette, ...[...rows].reverse(), ...[...maskRows].reverse()]);
}

function png(size: number, rgba: [number, number, number, number]): Buffer {
  const image = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i++) image.data.set(rgba, i * 4);
  return PNG.sync.write(image);
}

function pixels(file: Buffer): { width: number; height: number; at(x: number, y: number): number[] } {
  const image = PNG.sync.read(file);
  return { width: image.width, height: image.height, at: (x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)] };
}

describe('.ico icons', () => {
  it('converts a 32-bit bitmap entry with its alpha channel, rows in the right order', () => {
    // Top row: red, then half-transparent green. Bottom row: blue, then fully transparent.
    const rows = [Buffer.from([0, 0, 255, 255, 0, 255, 0, 128]), Buffer.from([255, 0, 0, 255, 0, 0, 0, 0])];
    const file = icoToPng(ico([{ size: 2, bits: 32, data: bitmap(2, 2, 32, rows, [[0, 0], [0, 0]]) }]));
    const image = pixels(file!);
    expect([image.width, image.height]).toEqual([2, 2]);
    expect(image.at(0, 0)).toEqual([255, 0, 0, 255]);
    expect(image.at(1, 0)).toEqual([0, 255, 0, 128]);
    expect(image.at(0, 1)).toEqual([0, 0, 255, 255]);
    expect(image.at(1, 1)[3]).toBe(0);
  });

  it('uses the mask for transparency in palette and 24-bit entries', () => {
    const palette = Buffer.from([0, 0, 0, 0, 255, 255, 255, 0]); // black, white
    // 1 bit per pixel, rows padded to 4 bytes: top row white then black, bottom row black then white.
    const rows = [Buffer.from([0b10000000, 0, 0, 0]), Buffer.from([0b01000000, 0, 0, 0])];
    const oneBit = pixels(icoToPng(ico([{ size: 2, bits: 1, data: bitmap(2, 2, 1, rows, [[0, 1], [0, 0]], palette) }]))!);
    expect(oneBit.at(0, 0)).toEqual([255, 255, 255, 255]);
    expect(oneBit.at(1, 0)[3]).toBe(0);
    expect(oneBit.at(0, 1)).toEqual([0, 0, 0, 255]);
    expect(oneBit.at(1, 1)).toEqual([255, 255, 255, 255]);

    const rgbRows = [Buffer.from([0, 128, 255, 0, 0, 0, 0, 0]), Buffer.from([255, 255, 255, 0, 0, 0, 0, 0])];
    const rgb = pixels(icoToPng(ico([{ size: 2, bits: 24, data: bitmap(2, 2, 24, rgbRows, [[0, 0], [1, 0]]) }]))!);
    expect(rgb.at(0, 0)).toEqual([255, 128, 0, 255]);
    expect(rgb.at(0, 1)[3]).toBe(0);
  });

  it('picks the image closest to 32px, keeping PNG entries as they are', () => {
    const small = png(16, [255, 0, 0, 255]);
    const right = png(32, [0, 255, 0, 255]);
    const large = png(64, [0, 0, 255, 255]);
    expect(icoToPng(ico([{ size: 16, bits: 32, data: small }, { size: 64, bits: 32, data: large }, { size: 32, bits: 32, data: right }]))).toEqual(right);
    expect(icoToPng(ico([{ size: 16, bits: 32, data: small }, { size: 64, bits: 32, data: large }]))).toEqual(large);
    expect(icoToPng(ico([{ size: 16, bits: 32, data: small }]))).toEqual(small);
  });

  it('refuses files that aren’t icons, and entries that point outside the file', () => {
    expect(isIco(png(16, [0, 0, 0, 255]))).toBe(false);
    expect(icoToPng(Buffer.from('<html>not found</html>'))).toBeNull();
    const broken = ico([{ size: 32, bits: 32, data: png(32, [0, 0, 0, 255]) }]);
    broken.writeUInt32LE(broken.length + 100, 6 + 8);
    expect(icoToPng(broken)).toBeNull();
    const truncated = ico([{ size: 2, bits: 32, data: bitmap(2, 2, 32, [Buffer.alloc(8), Buffer.alloc(8)], [[0, 0], [0, 0]]).subarray(0, 44) }]);
    expect(icoToPng(truncated)).toBeNull();
  });
});
