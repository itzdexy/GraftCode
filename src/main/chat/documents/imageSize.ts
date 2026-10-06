/**
 * The width and height of a picture, read from its header. Knows PNG, JPEG
 * and GIF, the kinds a document can hold; null for anything else.
 */
export function imageSize(data: Buffer): { width: number; height: number } | null {
  // PNG: the signature, then the IHDR chunk with both sizes as 32-bit numbers.
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.readUInt32BE(4) === 0x0d0a1a0a) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  // GIF: "GIF87a" or "GIF89a", then both sizes as little-endian 16-bit numbers.
  if (data.length >= 10 && data.subarray(0, 3).toString('latin1') === 'GIF') {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  // JPEG: segment after segment up to the start of frame, which holds the height, then the width.
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let at = 2;
    while (at + 9 <= data.length && data[at] === 0xff) {
      const marker = data[at + 1]!;
      const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (frame) return { width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
      at += 2 + data.readUInt16BE(at + 2);
    }
  }
  return null;
}
