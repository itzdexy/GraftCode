import { useEffect, useState } from 'react';
import { BookOpenText } from 'lucide-react';
import type { Source } from '@shared/sources';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { SiteIcon, siteName } from '../web/SearchResults';
import { openLink } from './Markdown';
import { SOURCES_SHOWN, sourcesHeading } from './sourcesModel';

/** Pictures are fetched once per address by the main process (see app/favicons.ts). */
const pictures = new Map<string, Promise<string | null>>();

function pictureFor(url: string): Promise<string | null> {
  let picture = pictures.get(url);
  if (!picture) {
    picture = invoke('web:pagePicture', { url }).catch(() => null);
    pictures.set(url, picture);
  }
  return picture;
}

/**
 * The tile beside a source: the page's own picture when it offers one. Until
 * that loads the tile shimmers, then the picture comes into focus; a page
 * without one keeps its site's icon.
 */
function PageTile({ source }: { source: Source }) {
  const [picture, setPicture] = useState<{ of: string; src: string | null } | null>(null);
  const wanted = source.image ?? null;
  useEffect(() => {
    if (wanted === null) return;
    let current = true;
    void pictureFor(wanted).then((src) => current && setPicture({ of: wanted, src }));
    return () => {
      current = false;
    };
  }, [wanted]);
  const loaded = picture !== null && picture.of === wanted ? picture : null;
  const waiting = wanted !== null && loaded === null;
  return (
    <span className={cn('flex h-44 w-64 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border-subtle bg-inset', waiting && 'graft-thumb-wait')}>
      {loaded?.src ? <img src={loaded.src} alt="" className="graft-reveal size-full object-cover" /> : waiting ? null : <SiteIcon url={source.url} size={18} />}
    </span>
  );
}

/**
 * The pages a reply read, each opening in the user's browser. A long list
 * shows its first pages until asked for the rest. When a page that was read
 * offers a picture, every row gets a tile for it; rows arrive one after
 * another in a list made while the session was open (`fresh`).
 */
export function SourcesCard({ sources, fresh = false }: { sources: Source[]; fresh?: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? sources : sources.slice(0, SOURCES_SHOWN);
  const pictured = shown.some((source) => source.image !== undefined);
  return (
    <section aria-label="Sources of this reply" className="overflow-hidden rounded-md border border-border-card">
      <header className="flex h-30 items-center gap-8 border-b border-border-subtle px-12 text-md">
        <BookOpenText className="size-13 shrink-0 text-icon" aria-hidden="true" />
        <span className="flex-1 font-medium text-fg-strong">{sourcesHeading(sources.length)}</span>
      </header>
      <ul className="flex flex-col py-2">
        {shown.map((source, i) => (
          <li key={source.url} className={fresh ? 'graft-chip-in' : undefined} style={fresh ? { animationDelay: `${String(Math.min(i, 12) * 40)}ms` } : undefined}>
            <button
              type="button"
              title={source.url}
              onClick={() => openLink(source.url)}
              className={cn('flex w-full min-w-0 items-center text-left text-md transition-ui hover:bg-hover', pictured ? 'gap-10 px-10 py-6' : 'h-32 gap-8 px-12')}
            >
              {pictured ? (
                <>
                  <PageTile source={source} />
                  <span className="flex min-w-0 flex-1 flex-col gap-2">
                    <span className="truncate font-medium text-fg">{source.title ?? source.url}</span>
                    <span className="flex min-w-0 items-center gap-6 text-sm text-fg-faint">
                      <SiteIcon url={source.url} size={12} />
                      <span className="truncate">{siteName(source.url)}</span>
                    </span>
                  </span>
                </>
              ) : (
                <>
                  <SiteIcon url={source.url} />
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">{source.title ?? source.url}</span>
                  <span className="shrink-0 text-sm text-fg-faint">{siteName(source.url)}</span>
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
      {sources.length > shown.length ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="flex h-30 w-full items-center border-t border-border-subtle px-12 text-left text-sm text-fg-muted transition-ui hover:bg-hover hover:text-fg"
        >
          Show all {sources.length} pages
        </button>
      ) : null}
    </section>
  );
}
