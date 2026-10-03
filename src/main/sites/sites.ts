import fs from 'node:fs';
import path from 'node:path';

/** What Graft keeps about a site, in its folder's .graft-site/site.json. */
export interface SiteManifest {
  name: string;
  /** What the user asked for when they started it. */
  description: string;
  createdAt: number;
  updatedAt: number;
  /** The session building it; null once that session is gone. */
  sessionId: string | null;
}

export interface SiteRecord extends SiteManifest {
  slug: string;
  folder: string;
}

const META_DIR = '.graft-site';
const MANIFEST = 'site.json';
const THUMBNAIL = 'thumbnail.png';

/** A folder and host name for a site: lowercase letters, digits and dashes. */
export function siteSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug.length > 0 ? slug : 'site';
}

/**
 * A name for a site from what the user asked for: a name they gave ("called
 * Peach Palace", or one in quotes), else the first few words.
 */
export function siteName(prompt: string): string {
  const text = prompt.trim();
  const named = /\b(?:called|named)\s+["“']?([^"”'.,:;!?()\n]{2,40})/i.exec(text) ?? /["“]([^"”\n]{2,40})["”]/.exec(text);
  if (named?.[1]) return named[1].trim();
  const words = text.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter((w) => w.length > 0);
  const short = words.slice(0, 4).join(' ');
  return short.length > 0 ? short.charAt(0).toUpperCase() + short.slice(1) : 'New site';
}

/** The page a site shows until the agent writes its index.html (served, never written into the folder). */
export function starterPage(name: string): string {
  const safe = name.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safe}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, sans-serif; background: radial-gradient(circle at 30% 20%, #e8f2e1, #f6f4ee 60%); color: #2b3326; }
  main { text-align: center; padding: 24px; }
  h1 { font-size: clamp(28px, 6vw, 44px); margin: 0 0 8px; letter-spacing: -0.02em; }
  p { margin: 0; color: #5d6858; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #5b9a45; margin-right: 8px; animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .3; } }
  @media (prefers-color-scheme: dark) { body { background: radial-gradient(circle at 30% 20%, #23301f, #151714 60%); color: #e9eee5; } p { color: #a8b3a2; } }
</style>
</head>
<body>
<main>
  <h1>${safe}</h1>
  <p><span class="dot"></span>Graft is building this site. It appears here as it takes shape.</p>
</main>
</body>
</html>
`;
}

/**
 * The websites Graft builds and hosts on this computer, one folder each under
 * the sites root (Documents/Graft Sites). A folder is a site when it holds
 * .graft-site/site.json; everything else in it is the site itself.
 */
export class SitesStore {
  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now
  ) {}

  private manifestPath(folder: string): string {
    return path.join(folder, META_DIR, MANIFEST);
  }

  private read(slug: string): SiteRecord | null {
    const folder = path.join(this.root, slug);
    try {
      const manifest = JSON.parse(fs.readFileSync(this.manifestPath(folder), 'utf8')) as Partial<SiteManifest>;
      if (typeof manifest.name !== 'string') return null;
      return {
        slug,
        folder,
        name: manifest.name,
        description: typeof manifest.description === 'string' ? manifest.description : '',
        createdAt: typeof manifest.createdAt === 'number' ? manifest.createdAt : 0,
        updatedAt: typeof manifest.updatedAt === 'number' ? manifest.updatedAt : 0,
        sessionId: typeof manifest.sessionId === 'string' ? manifest.sessionId : null
      };
    } catch {
      return null;
    }
  }

  private write(site: SiteRecord): void {
    const { name, description, createdAt, updatedAt, sessionId } = site;
    fs.mkdirSync(path.join(site.folder, META_DIR), { recursive: true });
    fs.writeFileSync(this.manifestPath(site.folder), `${JSON.stringify({ name, description, createdAt, updatedAt, sessionId }, null, 2)}\n`);
  }

  list(): SiteRecord[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && /^[a-z0-9-]+$/.test(e.name))
      .map((e) => this.read(e.name))
      .filter((s): s is SiteRecord => s !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(slug: string): SiteRecord | null {
    return /^[a-z0-9-]+$/.test(slug) ? this.read(slug) : null;
  }

  /** The site a folder belongs to (the folder itself or one inside it), if any. */
  forFolder(folder: string): SiteRecord | null {
    const rel = path.relative(this.root, folder);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return this.get(rel.split(path.sep)[0] ?? '');
  }

  /** A new site in a folder named after it; the server shows a starter page until it has an index.html. */
  create(name: string, description: string): SiteRecord {
    fs.mkdirSync(this.root, { recursive: true });
    const base = siteSlug(name);
    let slug = base;
    for (let n = 2; fs.existsSync(path.join(this.root, slug)); n++) slug = `${base}-${n}`;
    const folder = path.join(this.root, slug);
    fs.mkdirSync(folder, { recursive: true });
    const at = this.now();
    const site: SiteRecord = { slug, folder, name: name.trim() || 'New site', description: description.trim(), createdAt: at, updatedAt: at, sessionId: null };
    this.write(site);
    return site;
  }

  update(slug: string, patch: Partial<Pick<SiteManifest, 'name' | 'sessionId'>> & { touched?: boolean }): SiteRecord | null {
    const site = this.get(slug);
    if (!site) return null;
    const next: SiteRecord = {
      ...site,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}),
      updatedAt: patch.touched ? this.now() : site.updatedAt
    };
    this.write(next);
    return next;
  }

  saveThumbnail(slug: string, png: Buffer): void {
    const site = this.get(slug);
    if (!site) return;
    fs.mkdirSync(path.join(site.folder, META_DIR), { recursive: true });
    fs.writeFileSync(path.join(site.folder, META_DIR, THUMBNAIL), png);
  }

  /** The gallery picture as a data URL, when one was taken. */
  thumbnail(slug: string): string | null {
    const site = this.get(slug);
    if (!site) return null;
    try {
      return `data:image/png;base64,${fs.readFileSync(path.join(site.folder, META_DIR, THUMBNAIL)).toString('base64')}`;
    } catch {
      return null;
    }
  }
}
