/**
 * Chat files that open in their viewer when clicked. Scripts and programs
 * (.js, .py, .bat, .exe…) can only be saved or shown in their folder, so a
 * click never runs something a model wrote.
 */
const OPENABLE = new Set(['.txt', '.log', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.css', '.xml', '.yaml', '.yml', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf']);

function extensionOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export function canOpenChatFile(name: string): boolean {
  return OPENABLE.has(extensionOf(name));
}

const PLAYABLE = new Set(['.mp4', '.webm', '.mp3', '.wav', '.bmp', '.ico', '.avif']);

/** Files of a project that open with the computer's own app when asked: documents, pictures, clips and sound, never scripts or programs. */
export function canOpenProjectFile(name: string): boolean {
  const ext = extensionOf(name);
  return OPENABLE.has(ext) || PLAYABLE.has(ext);
}
