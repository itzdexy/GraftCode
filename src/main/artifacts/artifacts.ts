import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraftError } from '@shared/errors';
import type { ContentBlock } from '@shared/schemas/messages';
import type { Db } from '../db/database';
import { looksBinary } from '../tools/fs/read';
import { isInsideReal } from '../tools/paths';

/**
 * Artifacts are files the agent created or edited in a session. They are
 * found from the edit results stored with each session, and previewed either
 * as text or (HTML, SVG, images) through the sandboxed graft-artifact: scheme.
 */

export type ArtifactKind = 'html' | 'image' | 'markdown' | 'code' | 'other';

export interface Artifact {
  path: string;
  name: string;
  kind: ArtifactKind;
  sessionId: string;
  sessionTitle: string;
  projectName: string | null;
  created: boolean;
  updatedAt: number;
  exists: boolean;
  size: number | null;
}

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);
const HTML = new Set(['.html', '.htm']);
const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const CODE = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.py', '.rs', '.go', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.cs',
  '.rb', '.php', '.lua', '.sh', '.ps1', '.yaml', '.yml', '.toml', '.ini', '.sql', '.xml', '.txt', '.csv', '.env', '.dockerfile', '.vue', '.svelte'
]);

export function kindOf(file: string): ArtifactKind {
  const ext = path.extname(file).toLowerCase();
  if (HTML.has(ext)) return 'html';
  if (IMAGE.has(ext)) return 'image';
  if (MARKDOWN.has(ext)) return 'markdown';
  if (CODE.has(ext) || path.basename(file).toLowerCase() === 'dockerfile') return 'code';
  return 'other';
}

interface Row {
  session_id: string;
  content: string;
  created_at: number;
  title: string;
  cwd: string | null;
  worktree_path: string | null;
  project_name: string | null;
}

/** Resolves an edit result's display path against the folder the session worked in. */
export function resolveEditPath(shown: string, sessionDir: string | null): string | null {
  if (shown.startsWith('~/')) return path.join(os.homedir(), shown.slice(2));
  if (path.isAbsolute(shown)) return shown;
  return sessionDir ? path.resolve(sessionDir, shown) : null;
}

export function listArtifacts(db: Db, limit = 500): Artifact[] {
  const rows = db
    .prepare(
      `SELECT m.session_id, m.content, m.created_at, s.title, s.cwd, s.worktree_path, p.name AS project_name
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE m.role = 'user' AND m.content LIKE '%"kind":"edit"%'
       ORDER BY m.created_at DESC
       LIMIT 5000`
    )
    .all() as Row[];
  const byPath = new Map<string, Artifact>();
  for (const row of rows) {
    let blocks: ContentBlock[];
    try {
      blocks = JSON.parse(row.content) as ContentBlock[];
    } catch {
      // Unparseable rows can't contain edit results; skip them.
      continue;
    }
    for (const block of blocks) {
      if (block.type !== 'tool_result' || block.isError || block.display?.kind !== 'edit') continue;
      const abs = resolveEditPath(block.display.path, row.worktree_path ?? row.cwd);
      if (!abs) continue;
      const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
      const existing = byPath.get(key);
      if (existing) {
        if (block.display.created) existing.created = true;
        continue;
      }
      byPath.set(key, {
        path: abs,
        name: path.basename(abs),
        kind: kindOf(abs),
        sessionId: row.session_id,
        sessionTitle: row.title,
        projectName: row.project_name,
        created: block.display.created,
        updatedAt: row.created_at,
        exists: false,
        size: null
      });
    }
    if (byPath.size >= limit) break;
  }
  const list = [...byPath.values()];
  for (const a of list) {
    try {
      const stat = fs.statSync(a.path);
      a.exists = stat.isFile();
      a.size = stat.isFile() ? stat.size : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return list;
}

export function isKnownArtifact(db: Db, file: string): boolean {
  const target = path.resolve(file);
  return listArtifacts(db).some((a) => path.resolve(a.path) === target);
}

const MAX_TEXT = 512 * 1024;

export function readArtifactText(db: Db, file: string): { content: string | null; binary: boolean; tooLarge: boolean } {
  if (!isKnownArtifact(db, file)) throw new GraftError('not_an_artifact', 'That file is not an artifact from your sessions.');
  const stat = fs.statSync(file);
  if (stat.size > MAX_TEXT) return { content: null, binary: false, tooLarge: true };
  const buffer = fs.readFileSync(file);
  if (looksBinary(buffer)) return { content: null, binary: true, tooLarge: false };
  return { content: buffer.toString('utf8'), binary: false, tooLarge: false };
}

// ---- graft-artifact: protocol --------------------------------------------------

export const ARTIFACT_SCHEME = 'graft-artifact';

/** Pages run with scripts but no network, no forms, no plugins; they can't reach Graft. */
export const ARTIFACT_CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
};

/**
 * Maps unguessable tokens to an artifact's folder. A preview URL is
 * graft-artifact://<token>/<file>; relative assets resolve inside that
 * folder only. A token made for one file (a picture in the Files panel)
 * serves that file and nothing beside it.
 */
const MAX_PREVIEW_TOKENS = 64;

export class ArtifactServer {
  private readonly roots = new Map<string, { root: string; only: string | null }>();

  /** An address for a page and whatever it links to in its own folder. */
  urlFor(file: string): string {
    return this.grant(file, false);
  }

  /** An address for one file alone. */
  urlForFile(file: string): string {
    return this.grant(file, true);
  }

  private grant(file: string, alone: boolean): string {
    const resolved = path.resolve(file);
    const token = randomBytes(16).toString('hex');
    this.roots.set(token, { root: path.dirname(resolved), only: alone ? resolved : null });
    // Each preview gets a fresh token; forget the oldest so the map stays small.
    while (this.roots.size > MAX_PREVIEW_TOKENS) {
      const oldest = this.roots.keys().next().value;
      if (oldest === undefined) break;
      this.roots.delete(oldest);
    }
    return `${ARTIFACT_SCHEME}://${token}/${encodeURIComponent(path.basename(file))}`;
  }

  /** Serves a request; returns a Response for Electron's protocol.handle. */
  async respond(requestUrl: string): Promise<Response> {
    let url: URL;
    try {
      url = new URL(requestUrl);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const granted = this.roots.get(url.hostname);
    if (!granted) return new Response('Not found', { status: 404 });
    const { root, only } = granted;
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(root, rel);
    if (!isInsideReal(root, file) || (only !== null && file !== only)) return new Response('Forbidden', { status: 403 });
    let data: Buffer;
    try {
      data = await fs.promises.readFile(file);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-security-policy': ARTIFACT_CSP,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store'
      }
    });
  }
}
