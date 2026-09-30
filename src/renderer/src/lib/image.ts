const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export class ImageInputError extends Error {}

/** Decodes a picked or dropped file into an image element (object URL revoked after decode). */
export async function loadImageFile(file: File): Promise<HTMLImageElement> {
  if (!ACCEPTED.includes(file.type)) throw new ImageInputError('Use a PNG, JPEG, WebP or GIF image.');
  if (file.size > MAX_SOURCE_BYTES) throw new ImageInputError('That image is larger than 20 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (img.naturalWidth < 16 || img.naturalHeight < 16) throw new ImageInputError('That image is too small.');
    return img;
  } catch (error) {
    if (error instanceof ImageInputError) throw error;
    throw new ImageInputError("That file couldn't be read as an image.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface CropState {
  /** 1 = the image just covers the viewport. */
  zoom: number;
  /** Pan offset of the image center from the viewport center, in viewport pixels. */
  x: number;
  y: number;
}

/** Scale that makes the image cover a square viewport at zoom 1. */
export function coverScale(width: number, height: number, viewport: number): number {
  return Math.max(viewport / width, viewport / height);
}

/** Keeps the image covering the viewport after a zoom or pan. */
export function clampCrop(crop: CropState, width: number, height: number, viewport: number): CropState {
  const scale = coverScale(width, height, viewport) * crop.zoom;
  const maxX = Math.max(0, (width * scale - viewport) / 2);
  const maxY = Math.max(0, (height * scale - viewport) / 2);
  return { zoom: crop.zoom, x: Math.min(maxX, Math.max(-maxX, crop.x)), y: Math.min(maxY, Math.max(-maxY, crop.y)) };
}

/** Renders the visible square of the crop to a downscaled WebP data URL. */
export function renderCrop(img: HTMLImageElement, crop: CropState, viewport: number, outSize = 256): string {
  const canvas = document.createElement('canvas');
  canvas.width = outSize;
  canvas.height = outSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageInputError('Image processing is unavailable.');
  const k = outSize / viewport;
  const scale = coverScale(img.naturalWidth, img.naturalHeight, viewport) * crop.zoom;
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, ((viewport - w) / 2 + crop.x) * k, ((viewport - h) / 2 + crop.y) * k, w * k, h * k);
  const webp = canvas.toDataURL('image/webp', 0.88);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.88);
}

/** Reads an image file as base64 (no data: prefix) for message attachments. */
export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
