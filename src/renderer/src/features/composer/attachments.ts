import { IMAGE_MEDIA_TYPES, type ImageBlock } from '@shared/schemas/messages';
import { fileToBase64 } from '../../lib/image';

/** Raw bytes limit so the base64 payload stays under common provider caps (5 MB). */
export const MAX_IMAGE_BYTES = 3_750_000;
export const MAX_IMAGES = 20;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export function isImageType(type: string): type is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);
}

export interface AttachmentResult {
  images: ImageBlock[];
  rejected: string[];
}

/** Converts picked, pasted or dropped files into image blocks, explaining any that were skipped. */
export async function filesToImages(files: File[], room: number): Promise<AttachmentResult> {
  const images: ImageBlock[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    if (!isImageType(file.type)) {
      rejected.push(`${file.name || 'File'}: only PNG, JPEG, GIF and WebP images can be attached.`);
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      rejected.push(`${file.name || 'Image'} is larger than 3.75 MB.`);
      continue;
    }
    if (images.length >= room) {
      rejected.push(`Only ${MAX_IMAGES} images fit in one message.`);
      break;
    }
    images.push({ type: 'image', mediaType: file.type, data: await fileToBase64(file) });
  }
  return { images, rejected };
}

export function imageSrc(image: ImageBlock): string {
  return `data:${image.mediaType};base64,${image.data}`;
}
