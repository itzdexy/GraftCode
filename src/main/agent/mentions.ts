import fs from 'node:fs';
import { formatLines, looksBinary } from '../tools/fs/read';
import { displayPath, isInsideReal, resolvePath } from '../tools/paths';

/**
 * "@path" mentions in a user message attach the file (or a directory listing)
 * to that message, so the model sees it without a Read round trip. Only
 * paths inside the project are attached; anything else is left for the agent
 * to read through its tools (and their permission checks).
 */

const MENTION = /(^|\s)@("[^"]+"|[^\s"'`]+)/g;
const MAX_FILE_BYTES = 200_000;
const MAX_TOTAL_BYTES = 400_000;
const MAX_ATTACHMENTS = 10;
const MAX_DIR_ENTRIES = 200;

export function findMentions(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(MENTION)) {
    let raw = match[2] ?? '';
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    else raw = raw.replace(/[),.;:!?]+$/, '');
    if (raw.length > 0 && !found.includes(raw)) found.push(raw);
  }
  return found;
}

export interface ExpandedMentions {
  /** Text blocks to append to the user message. */
  blocks: string[];
  /** Absolute paths of files whose full content was attached (count as read). */
  files: string[];
}

export function expandMentions(text: string, cwd: string, root: string, platform: NodeJS.Platform = process.platform): ExpandedMentions {
  const blocks: string[] = [];
  const files: string[] = [];
  let total = 0;
  for (const raw of findMentions(text).slice(0, MAX_ATTACHMENTS)) {
    const abs = resolvePath(raw, cwd);
    const shown = displayPath(abs, root, platform);
    if (!isInsideReal(root, abs, platform)) {
      blocks.push(`@${raw} is outside the project folder, so it was not attached. Read it with your tools if it is needed.`);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      blocks.push(`@${raw} does not exist (looked for ${shown}).`);
      continue;
    }
    if (stat.isDirectory()) {
      const entries = fs
        .readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.name !== '.git')
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .slice(0, MAX_DIR_ENTRIES)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      blocks.push(`<directory path="${shown}">\n${entries.join('\n')}\n</directory>`);
      continue;
    }
    if (stat.size > MAX_FILE_BYTES || total + stat.size > MAX_TOTAL_BYTES) {
      blocks.push(`@${shown} is too large to attach (${Math.round(stat.size / 1024)} KB). Read the parts you need with the Read tool.`);
      continue;
    }
    const buffer = fs.readFileSync(abs);
    if (looksBinary(buffer)) {
      blocks.push(`@${shown} is a binary file and was not attached.`);
      continue;
    }
    total += stat.size;
    const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    blocks.push(`<file path="${shown}">\n${formatLines(lines, 1)}\n</file>`);
    files.push(abs);
  }
  return { blocks, files };
}
