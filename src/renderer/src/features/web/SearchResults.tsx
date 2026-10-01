import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { reportError } from '../../stores/toasts';
import type { SearchInfo } from '../session/transcriptModel';

/** Icons are fetched once per host by the main process (see app/favicons.ts). */
const icons = new Map<string, Promise<string | null>>();

function iconFor(host: string): Promise<string | null> {
  let icon = icons.get(host);
  if (!icon) {
    icon = invoke('web:favicon', { host }).catch(() => null);
    icons.set(host, icon);
  }
  return icon;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Host as people read it: no "www."; `site` wins when the URL is a redirect. */
export function siteName(url: string, site?: string): string {
  return (site ?? hostname(url)).replace(/^www\./, '') || url;
}

/** A site's icon, or a letter tile in a color of its own while it loads or when the site has none. */
export function SiteIcon({ url, site, size = 14 }: { url: string; site?: string; size?: number }) {
  const host = site ?? hostname(url);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    if (host) void iconFor(host).then((icon) => current && setSrc(icon));
    return () => {
      current = false;
    };
  }, [host]);
  if (src) return <img src={src} alt="" width={size} height={size} className="shrink-0 rounded-xs" />;
  const name = siteName(url, site);
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-xs text-[9px] leading-none font-semibold text-white"
      style={{ width: size, height: size, background: `hsl(${String(hue)} 42% 40%)` }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function open(url: string): void {
  invoke('app:openExternal', { url }).catch((error: unknown) => reportError("Couldn't open the page", error));
}

/** One chip per site (the first result from it), in the order they were found. */
function bySite(results: SearchInfo['results']): SearchInfo['results'] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const name = siteName(r.url, r.site);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/** Result sites as chips with their icons; they arrive one after another. */
export function SearchChips({ results: all, max = 6 }: { results: SearchInfo['results']; max?: number }) {
  const results = bySite(all);
  const shown = results.slice(0, max);
  return (
    <ul aria-label="Sites found" className="flex flex-wrap gap-6">
      {shown.map((r, i) => (
        <li key={r.url} className="graft-chip-in" style={{ animationDelay: `${String(i * 45)}ms` }}>
          <button
            type="button"
            title={r.title}
            onClick={() => open(r.url)}
            className="flex h-24 max-w-[220px] items-center gap-6 rounded-full border border-border bg-raised pr-10 pl-6 text-sm text-fg-secondary transition-ui hover:bg-hover hover:text-fg"
          >
            <SiteIcon url={r.url} site={r.site} />
            <span className="truncate">{siteName(r.url, r.site)}</span>
          </button>
        </li>
      ))}
      {results.length > max ? (
        <li className="graft-chip-in" style={{ animationDelay: `${String(shown.length * 45)}ms` }}>
          <span className="flex h-24 items-center rounded-full border border-border px-10 text-sm text-fg-muted">{results.length - max} more</span>
        </li>
      ) : null}
    </ul>
  );
}

/** Every result with its title, for the opened step. */
export function SearchResultList({ results }: { results: SearchInfo['results'] }) {
  return (
    <ul className="flex flex-col gap-2">
      {results.map((r) => (
        <li key={r.url}>
          <button
            type="button"
            onClick={() => open(r.url)}
            className="flex w-full min-w-0 items-center gap-8 rounded-sm px-4 py-2 text-left text-sm transition-ui hover:bg-hover"
          >
            <SiteIcon url={r.url} site={r.site} />
            <span className="min-w-0 flex-1 truncate text-fg-secondary">{r.title}</span>
            <span className="shrink-0 text-fg-faint">{siteName(r.url, r.site)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One web search in a turn: shimmering while it runs, then the sites it found. */
export function SearchStep({ search, live, error }: { search: SearchInfo; live: boolean; error?: string | null }) {
  const [open, setOpen] = useState(false);
  const label = live ? `Searching the web for “${search.query}”` : `Searched the web for “${search.query}”`;
  return (
    <div className="flex flex-col gap-4 px-4 py-2">
      <button
        type="button"
        aria-expanded={open}
        disabled={search.results.length === 0}
        onClick={() => setOpen(!open)}
        className="flex min-h-22 items-center gap-6 self-start text-left text-md text-fg-muted transition-ui enabled:hover:text-fg-secondary"
      >
        <Globe className={cn('size-12 shrink-0', live && 'graft-spin-slow')} aria-hidden="true" />
        <span className={cn('min-w-0', live && 'graft-shimmer')}>{label}</span>
        {!live && search.results.length > 0 ? <span className="shrink-0 text-sm text-fg-faint">· {search.results.length} results</span> : null}
      </button>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {open ? <SearchResultList results={search.results} /> : search.results.length > 0 ? <SearchChips results={search.results} /> : null}
    </div>
  );
}
