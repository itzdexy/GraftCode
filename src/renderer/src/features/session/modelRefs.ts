import { modelFormat } from '../models/modelFormats';
import { parseFileRef } from './fileRefs';
import type { ToolCall } from './transcriptModel';

/** A turn's card draws at most this many models; the rest open from the Files panel. */
export const MAX_TURN_MODELS = 4;

const CODE_SPAN = /`([^`\n]{1,300})`/g;

/**
 * The 3D models a finished turn made or named: files its tools wrote, then
 * files its replies name in code spans (`exports/gun.glb`), the way any file
 * named in a reply is found. Whether each exists is asked afterwards; a model
 * exported by a script or by Blender is only known by its name in the reply.
 */
export function turnModels(texts: string[], calls: ToolCall[]): string[] {
  const found: string[] = [];
  const add = (path: string): void => {
    const clean = path.replace(/\\/g, '/');
    if (modelFormat(clean) && !found.includes(clean)) found.push(clean);
  };
  for (const call of calls) {
    const display = call.result?.display;
    if (display?.kind === 'edit' && !call.result?.isError) add(display.path);
  }
  for (const text of texts) {
    for (const match of text.matchAll(CODE_SPAN)) {
      const ref = parseFileRef(match[1] ?? '');
      if (ref) add(ref.path);
    }
  }
  return found.slice(0, MAX_TURN_MODELS);
}
