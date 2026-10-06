import { useState } from 'react';
import { BookOpenText } from 'lucide-react';
import type { Source } from '@shared/sources';
import { SiteIcon, siteName } from '../web/SearchResults';
import { openLink } from './Markdown';
import { SOURCES_SHOWN, sourcesHeading } from './sourcesModel';

/** The pages a reply read, each opening in the user's browser. A long list shows its first pages until asked for the rest. */
export function SourcesCard({ sources }: { sources: Source[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? sources : sources.slice(0, SOURCES_SHOWN);
  return (
    <section aria-label="Sources of this reply" className="overflow-hidden rounded-md border border-border-card">
      <header className="flex h-30 items-center gap-8 border-b border-border-subtle px-12 text-md">
        <BookOpenText className="size-13 shrink-0 text-icon" aria-hidden="true" />
        <span className="flex-1 font-medium text-fg-strong">{sourcesHeading(sources.length)}</span>
      </header>
      <ul className="flex flex-col py-2">
        {shown.map((source) => (
          <li key={source.url}>
            <button
              type="button"
              title={source.url}
              onClick={() => openLink(source.url)}
              className="flex h-32 w-full min-w-0 items-center gap-8 px-12 text-left text-md transition-ui hover:bg-hover"
            >
              <SiteIcon url={source.url} />
              <span className="min-w-0 flex-1 truncate font-medium text-fg">{source.title ?? source.url}</span>
              <span className="shrink-0 text-sm text-fg-faint">{siteName(source.url)}</span>
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
