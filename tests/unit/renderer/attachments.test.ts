import { describe, expect, it } from 'vitest';
import { looksLikeText, MAX_TEXT_FILE_BYTES, readAttachments } from '../../../src/renderer/src/features/composer/attachments';

const ROOM = { images: 20, files: 10, allowImages: true };
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('composer attachments', () => {
  it('reads text files and images, and explains skipped files', async () => {
    const result = await readAttachments(
      [
        new File(['const a = 1;\n'], 'a.ts', { type: 'video/mp2t' }),
        new File([PNG_BYTES], 'shot.png', { type: 'image/png' }),
        new File([Uint8Array.from([0x00, 0x01, 0x02, 0xff])], 'blob.bin', { type: 'application/octet-stream' }),
        new File(['x'], 'art.bmp', { type: 'image/bmp' }),
        new File(['y'.repeat(MAX_TEXT_FILE_BYTES + 1)], 'huge.log', { type: 'text/plain' })
      ],
      ROOM
    );
    expect(result.files).toEqual([{ name: 'a.ts', content: 'const a = 1;\n' }]);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ type: 'image', mediaType: 'image/png' });
    expect(result.rejected).toEqual([
      "blob.bin isn't a text file. Attach images or text files.",
      'art.bmp: only PNG, JPEG, GIF and WebP images can be attached.',
      'huge.log is larger than 200 KB.'
    ]);
  });

  it('keeps text files when the model cannot read images, and respects the room left', async () => {
    const files = [new File([PNG_BYTES], 'shot.png', { type: 'image/png' }), new File(['one'], '1.txt'), new File(['two'], '2.txt')];
    const result = await readAttachments(files, { images: 20, files: 1, allowImages: false });
    expect(result.images).toEqual([]);
    expect(result.files.map((f) => f.name)).toEqual(['1.txt']);
    expect(result.rejected).toEqual(["shot.png: this model can't read images.", 'Only 10 files fit in one message.']);
  });

  it('tells text from binary', () => {
    expect(looksLikeText('plain words\nand more')).toBe(true);
    expect(looksLikeText('')).toBe(true);
    expect(looksLikeText('has a \u0000 byte')).toBe(false);
    expect(looksLikeText('\uFFFD\uFFFD\uFFFD\uFFFD')).toBe(false);
  });
});
