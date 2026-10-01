import { IMAGE_MEDIA_TYPES, type FileAttachment, type ImageBlock } from '@shared/schemas/messages';
import { fileToBase64 } from '../../lib/image';

/** Raw bytes limit so the base64 payload stays under common provider caps (5 MB). */
export const MAX_IMAGE_BYTES = 3_750_000;
export const MAX_IMAGES = 20;
/** Text files are sent inline, so they share the message's size budget. */
export const MAX_TEXT_FILE_BYTES = 200_000;
export const MAX_TEXT_FILES = 10;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export function isImageType(type: string): type is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);
}

/** Decoded text that contains NUL bytes or many invalid UTF-8 sequences came from a binary file. */
export function looksLikeText(content: string): boolean {
  if (content.includes('\u0000')) return false;
  let replaced = 0;
  for (const ch of content) if (ch === '\uFFFD') replaced++;
  return replaced <= Math.max(2, content.length / 1000);
}

export interface AttachmentRoom {
  images: number;
  files: number;
  /** False when the current model can't read images. */
  allowImages: boolean;
}

export interface AttachmentResult {
  images: ImageBlock[];
  files: FileAttachment[];
  rejected: string[];
}

/** Sorts picked, pasted or dropped files into images and text files, explaining any that were skipped. */
export async function readAttachments(files: File[], room: AttachmentRoom): Promise<AttachmentResult> {
  const images: ImageBlock[] = [];
  const texts: FileAttachment[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    const name = file.name || 'File';
    if (isImageType(file.type)) {
      if (!room.allowImages) rejected.push(`${name}: this model can't read images.`);
      else if (file.size > MAX_IMAGE_BYTES) rejected.push(`${name} is larger than 3.75 MB.`);
      else if (images.length >= room.images) rejected.push(`Only ${MAX_IMAGES} images fit in one message.`);
      else images.push({ type: 'image', mediaType: file.type, data: await fileToBase64(file) });
      continue;
    }
    if (file.type.startsWith('image/')) {
      rejected.push(`${name}: only PNG, JPEG, GIF and WebP images can be attached.`);
      continue;
    }
    if (file.size > MAX_TEXT_FILE_BYTES) {
      rejected.push(`${name} is larger than 200 KB.`);
      continue;
    }
    if (texts.length >= room.files) {
      rejected.push(`Only ${MAX_TEXT_FILES} files fit in one message.`);
      continue;
    }
    const content = await file.text();
    if (!looksLikeText(content)) {
      rejected.push(`${name} isn't a text file. Attach images or text files.`);
      continue;
    }
    texts.push({ name: name.slice(0, 255), content });
  }
  return { images, files: texts, rejected: [...new Set(rejected)] };
}

export function imageSrc(image: ImageBlock): string {
  return `data:${image.mediaType};base64,${image.data}`;
}
