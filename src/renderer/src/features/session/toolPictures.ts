import type { ImageBlock, ToolResultBlock } from '@shared/schemas/messages';
import type { ToolDisplay } from '@shared/schemas/toolDisplay';

/**
 * The pictures a tool sent back with its result: a render from Blender, a
 * capture of Roblox Studio, a screenshot, a picture it read. Pure, so it is
 * unit-tested without a DOM.
 */

/** Details that already draw the picture their tool sent, large. */
const DRAWS_ITS_PICTURE: ReadonlySet<ToolDisplay['kind']> = new Set(['read', 'computer', 'browser']);

export function resultPictures(result: ToolResultBlock | null): ImageBlock[] {
  return result ? result.content.filter((block): block is ImageBlock => block.type === 'image') : [];
}

/** The pictures a call's details still have to draw. */
export function picturesToDraw(result: ToolResultBlock | null): ImageBlock[] {
  if (!result || (result.display && DRAWS_ITS_PICTURE.has(result.display.kind))) return [];
  return resultPictures(result);
}

export function pictureSrc(image: ImageBlock): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

/** A picture's name in the viewer: the call's own words, and its place when the call sent several. */
export function pictureName(title: string, index: number, count: number): string {
  return count <= 1 ? title : `${title} (${String(index + 1)} of ${String(count)})`;
}
