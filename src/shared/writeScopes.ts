/**
 * The paths an agent of a group may change ("writes" in RunAgents): files,
 * folders or patterns, relative to the project. Agents whose paths can't
 * name the same file work side by side; this module decides whether they can.
 * Shared by the scheduler (main) and the Agents panel (renderer).
 */

const WILDCARD = /[*?[\]{}]/;

/** A path as scopes are compared: forward slashes, no leading "./", no trailing slash. */
export function normalizeScope(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
}

/** The folder or file a scope starts at: everything before its first wildcard. "" is the whole project. */
export function scopeRoot(scope: string): string {
  const fixed: string[] = [];
  for (const part of normalizeScope(scope).split('/')) {
    if (part === '' || part === '.') continue;
    if (WILDCARD.test(part)) break;
    fixed.push(part);
  }
  return fixed.join('/');
}

/**
 * Whether two scopes could name the same file. It compares where they start,
 * ignoring case, so it errs towards "yes": "src/**\/*.ts" and "src/**\/*.css"
 * overlap here, and the agents holding them simply take turns.
 */
export function scopesOverlap(a: string, b: string): boolean {
  const ra = scopeRoot(a).toLowerCase();
  const rb = scopeRoot(b).toLowerCase();
  if (ra === '' || rb === '') return true;
  return ra === rb || ra.startsWith(`${rb}/`) || rb.startsWith(`${ra}/`);
}

export function anyOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => scopesOverlap(x, y)));
}

/** Why a list of scopes can't be used, or null when it can. */
export function scopeProblem(scopes: string[]): string | null {
  if (scopes.length === 0) return 'Give at least one path in writes, or leave it out.';
  for (const raw of scopes) {
    const scope = normalizeScope(raw);
    if (/^([A-Za-z]:|\/|~)/.test(scope) || scope.split('/').includes('..')) return `"${raw}" has to be a path inside the project.`;
    if (scopeRoot(scope) === '') return `"${raw}" names the whole project. Leave writes out for an agent that may change any file; it then works alone.`;
  }
  return null;
}
