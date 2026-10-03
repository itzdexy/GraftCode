/**
 * Chat files that open in their viewer when clicked. Scripts and programs
 * (.js, .py, .bat, .exe…) can only be saved or shown in their folder, so a
 * click never runs something a model wrote.
 */
const OPENABLE = new Set(['.txt', '.log', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.css', '.xml', '.yaml', '.yml', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf']);

export function canOpenChatFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && OPENABLE.has(name.slice(dot).toLowerCase());
}
