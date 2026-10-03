import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUp, ExternalLink, FolderOpen, Globe, Trash } from 'lucide-react';
import type { SiteView } from '@shared/schemas/sites';
import { Button, IconButton } from '../../components/Button';
import { TextField } from '../../components/Field';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { onChanged } from '../../lib/bus';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { errorText, invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { useNav } from '../../stores/nav';
import { usePanels } from '../../stores/panels';
import { reportError } from '../../stores/toasts';
import { ConfirmDialog } from '../settings/common';
import { PageLayout } from '../shell/PageLayout';

/** Starting points that show what a good brief looks like. */
const IDEAS: Array<{ label: string; prompt: string }> = [
  {
    label: 'Bakery',
    prompt:
      'A warm, cheerful website for my neighborhood bakery called Peach Palace: seasonal bakes, a menu with prices, opening hours, a map, and a clear way to reserve a table or order for pickup. Soft peach tones and a handcrafted feel.'
  },
  {
    label: 'Photographer',
    prompt:
      'A minimal portfolio for a landscape photographer: a full-bleed hero, a filterable gallery, a short about section, prints for sale, and a contact form. Lots of white space, elegant serif headings.'
  },
  {
    label: 'App launch',
    prompt:
      'A landing page for a habit-tracking app called Streakly: a bold hero with the app in a phone frame, three key features, testimonials, pricing with a free and a pro plan, FAQ, and download buttons. Energetic and modern.'
  },
  {
    label: 'Restaurant',
    prompt:
      'A refined site for a small Italian restaurant named Osteria Verde: the story, a seasonal menu, a wine list, a gallery, reservations and location. Dark green and cream, editorial typography.'
  },
  {
    label: 'Conference',
    prompt:
      'A one-page site for a two-day design conference called Shape 2027: dates and venue, speakers with photos, a schedule with tabs per day, ticket tiers, sponsors and a newsletter signup.'
  },
  {
    label: 'Studio',
    prompt:
      'A confident website for a small branding studio named North & Co: case studies with large imagery, services, the team, a process section and a contact page. Monochrome with one striking accent color.'
  }
];

/** Opens a site's session with its live preview in the Browser panel. */
async function openSite(site: Pick<SiteView, 'slug' | 'url'>, sessionId?: string): Promise<void> {
  const id = sessionId ?? (await invoke('sites:session', { slug: site.slug })).sessionId;
  useNav.getState().go({ name: 'session', id });
  usePanels.getState().show(id, 'browser');
  await invoke('browser:navigate', { url: site.url });
}

function NewSite({ onCreated }: { onCreated: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { site, sessionId } = await invoke('sites:create', { prompt: prompt.trim(), ...(name.trim() ? { name: name.trim() } : {}) });
      onCreated();
      await openSite(site, sessionId);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="composer-box mt-20 flex flex-col gap-10 rounded-lg border border-border-card bg-raised p-12">
      <textarea
        aria-label="Describe your site"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(e);
        }}
        rows={4}
        placeholder="Describe your site: who it’s for, the feel you want, and the pages it needs…"
        className="w-full resize-none bg-transparent text-md leading-[1.5] text-fg outline-none placeholder:text-fg-faint"
      />
      <div className="flex flex-wrap items-center gap-8">
        <TextField aria-label="Site name (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className="w-[200px]" />
        <span className="flex-1" />
        <Button type="submit" variant="primary" disabled={!prompt.trim() || busy} trailing={<ArrowUp className="size-14" />}>
          {busy ? 'Starting…' : 'Build site'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-6 border-t border-border-subtle pt-10">
        <span className="text-sm text-fg-muted">Start from:</span>
        {IDEAS.map((idea) => (
          <button
            key={idea.label}
            type="button"
            onClick={() => setPrompt(idea.prompt)}
            className="h-24 rounded-full border border-border px-10 text-sm text-fg-secondary transition-ui hover:border-border-strong hover:text-fg"
          >
            {idea.label}
          </button>
        ))}
      </div>
    </form>
  );
}

function SiteCard({ site, onRemove }: { site: SiteView; onRemove: () => void }) {
  const open = (): void => {
    openSite(site).catch((e: unknown) => reportError("Couldn't open the site", e));
  };
  return (
    <li className="motion-rise group flex flex-col overflow-hidden rounded-lg border border-border-card bg-raised transition-ui hover:border-border-strong">
      <button type="button" onClick={open} aria-label={`Open ${site.name}`} className="relative block aspect-[16/10] w-full overflow-hidden bg-sunken">
        {site.thumbnail ? (
          <img src={site.thumbnail} alt="" className="h-full w-full object-cover object-top transition-transform duration-[var(--g-duration-slow)] group-hover:scale-[1.02]" />
        ) : (
          <span className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_30%_20%,color-mix(in_srgb,var(--g-accent)_22%,transparent),transparent_60%)]">
            <span className="text-[40px] font-semibold text-fg-faint" aria-hidden="true">
              {site.name.charAt(0).toUpperCase()}
            </span>
          </span>
        )}
      </button>
      <div className="flex items-start gap-8 px-12 py-10">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-medium text-fg-strong">{site.name}</p>
          <p className="truncate font-mono text-xs text-fg-faint" title={site.url}>
            {site.url.replace(/^http:\/\//, '').replace(/\/$/, '')}
          </p>
          <p className="mt-2 text-xs text-fg-muted">Updated {relativeTime(site.updatedAt)}</p>
        </div>
        <IconButton label="Open in your browser" size="sm" onClick={() => void invoke('app:openExternal', { url: site.url })}>
          <ExternalLink className="size-14" />
        </IconButton>
        <IconButton label="Show folder" size="sm" onClick={() => invoke('sites:reveal', { slug: site.slug }).catch((e: unknown) => reportError("Couldn't open the folder", e))}>
          <FolderOpen className="size-14" />
        </IconButton>
        <IconButton label={`Delete ${site.name}`} size="sm" onClick={onRemove}>
          <Trash className="size-14" />
        </IconButton>
      </div>
    </li>
  );
}

/**
 * Sites: describe a website and Graft builds it in its own folder and hosts it
 * on this computer, with a live preview beside the session that builds it.
 */
export function SitesView() {
  const [tick, setTick] = useState(0);
  const { load, reload } = useLoad(() => invoke('sites:list'), String(tick));
  const [removing, setRemoving] = useState<SiteView | null>(null);
  useEffect(() => onChanged('sites', () => setTick((n) => n + 1)), []);
  const sites = load.status === 'ready' ? load.data : [];

  return (
    <PageLayout
      wide
      title="Sites"
      description="Describe a website and Graft designs and builds it, then hosts it on this computer with a live preview. Each site is a plain folder on this computer, ready to publish anywhere."
    >
      <NewSite onCreated={reload} />
      <section aria-label="Your sites" className="mt-28">
        <h2 className="mb-12 flex items-center gap-8 text-md font-medium text-fg-strong">
          <Globe className="size-14 text-icon-muted" aria-hidden="true" />
          Your sites
        </h2>
        {load.status === 'loading' ? <LoadingState /> : null}
        {load.status === 'error' ? <ErrorState message={load.message} onRetry={reload} /> : null}
        {load.status === 'ready' && sites.length === 0 ? (
          <EmptyState title="No sites yet" description="Describe one above, or start from an idea. It appears here with a preview once Graft has built it." />
        ) : null}
        {sites.length > 0 ? (
          <ul className={cn('motion-stagger grid gap-14', 'grid-cols-[repeat(auto-fill,minmax(240px,1fr))]')}>
            {sites.map((site) => (
              <SiteCard key={site.slug} site={site} onRemove={() => setRemoving(site)} />
            ))}
          </ul>
        ) : null}
      </section>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing ? `Delete ${removing.name}?` : 'Delete site?'}
        description="Its folder goes to the Recycle Bin, so you can still restore it. The session that built it stays in your list."
        confirmLabel="Delete site"
        danger
        onConfirm={async () => {
          if (!removing) return;
          await invoke('sites:remove', { slug: removing.slug });
          setRemoving(null);
          reload();
        }}
      />
    </PageLayout>
  );
}
