import { useState, type ReactNode } from 'react';
import { AudioLines, Captions, Check, Clapperboard, ImageIcon, Music, RefreshCw, Search } from 'lucide-react';
import type { MediaModel, MediaModelKind } from '@shared/ipc/contracts';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { ErrorState, LoadingState } from '../../components/States';
import { invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { useApp } from '../../stores/app';
import { Group, saveSettings } from './common';
import { durationText, inUse, mediaSections, providerNote, secondPriceText, actionFor, patchFor, type MediaSection, type ProviderGroup } from './mediaModels';

/** Rows a provider shows before "Show all". */
const SHOWN = 6;

const KIND_ICON: Record<MediaModelKind, ReactNode> = {
  image: <ImageIcon className="size-14" />,
  video: <Clapperboard className="size-14" />,
  speech: <AudioLines className="size-14" />,
  audio: <Music className="size-14" />,
  transcription: <Captions className="size-14" />
};

const USE_LABEL = { images: 'Use for images', video: 'Use for video', 'read-aloud': 'Use for Read aloud' } as const;

/** What else is worth knowing about a model, in a line: its lengths, shapes, price, voices. */
function facts(model: MediaModel): string[] {
  return [
    durationText(model.durations),
    model.aspects && model.aspects.length > 0 ? model.aspects.slice(0, 4).join(', ') + (model.aspects.length > 4 ? '…' : '') : null,
    model.firstFrame ? 'starts on a picture' : null,
    secondPriceText(model.pricePerSecond),
    model.voices && model.voices.length > 0 ? `${String(model.voices.length)} voice${model.voices.length === 1 ? '' : 's'}` : null
  ].filter((f): f is string => f !== null);
}

function ModelRow({ model, kind, providerKind }: { model: MediaModel; kind: MediaModelKind; providerKind: string }) {
  const settings = useApp((s) => s.settings);
  if (!settings) return null;
  const use = actionFor(kind, providerKind, model);
  const current = inUse(kind, providerKind, model, settings);
  const details = facts(model);
  return (
    <li className="motion-rise flex items-start gap-10 px-14 py-9">
      <span className="mt-2 flex size-24 shrink-0 items-center justify-center rounded-md bg-control text-icon" aria-hidden="true">
        {KIND_ICON[kind]}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-6">
          <span className="truncate text-base text-fg">{model.name}</span>
          {current ? (
            <Badge tone="accent" icon={<Check className="size-10" />}>
              In use
            </Badge>
          ) : null}
        </p>
        <p className="truncate font-mono text-2xs text-fg-faint" title={model.id}>
          {model.id}
          {details.length > 0 ? <span className="font-sans text-xs text-fg-muted"> · {details.join(' · ')}</span> : null}
        </p>
        {model.description ? (
          <p className="mt-2 line-clamp-2 text-sm text-fg-muted" title={model.description}>
            {model.description}
          </p>
        ) : null}
      </div>
      {use && !current ? (
        <Button size="sm" variant="ghost" aria-label={`${USE_LABEL[use]}: ${model.name}`} onClick={() => saveSettings(patchFor(use, providerKind, model), "Couldn't choose the model")}>
          {USE_LABEL[use]}
        </Button>
      ) : null}
    </li>
  );
}

function ProviderModels({ group, kind, searching }: { group: ProviderGroup; kind: MediaModelKind; searching: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all || searching ? group.models : group.models.slice(0, SHOWN);
  const note = providerNote(kind, group.providerKind);
  return (
    <div className="flex flex-col">
      <p className="flex flex-wrap items-center gap-x-8 px-14 pt-10 pb-2 text-sm font-medium text-fg-secondary">
        {group.providerLabel}
        <span className="tabular-nums text-xs font-normal text-fg-faint">{String(group.models.length)}</span>
        {note ? <span className="text-xs font-normal text-fg-muted">{note}</span> : null}
      </p>
      {group.error ? (
        <p role="alert" className="px-14 pb-8 text-sm text-amber-fg">
          Couldn’t list {group.providerLabel}’s models: {group.error}
        </p>
      ) : null}
      <ul aria-label={`${group.providerLabel}: ${kind} models`} className="flex flex-col">
        {shown.map((model) => (
          <ModelRow key={model.id} model={model} kind={kind} providerKind={group.providerKind} />
        ))}
      </ul>
      {shown.length < group.models.length ? (
        <button type="button" onClick={() => setAll(true)} className="self-start px-14 pt-2 pb-10 text-sm text-link transition-ui hover:underline">
          Show all {String(group.models.length)}
        </button>
      ) : null}
    </div>
  );
}

function Section({ section, searching, actions }: { section: MediaSection; searching: boolean; actions?: ReactNode }) {
  return (
    <Group
      title={section.title}
      description={
        <>
          {section.description}{' '}
          <span className="tabular-nums text-fg-faint">
            {String(section.count)} model{section.count === 1 ? '' : 's'}
          </span>
        </>
      }
      actions={actions}
    >
      {section.providers.map((group) => (
        <ProviderModels key={group.providerId} group={group} kind={section.kind} searching={searching} />
      ))}
    </Group>
  );
}

/**
 * Settings → Models, below the text models: a section each for the image, video, voice, music and transcription
 * models of the providers that are set up, with Use where Graft can use one.
 */
export function MediaModelsSections() {
  const [refresh, setRefresh] = useState(0);
  const { load, reload } = useLoad(() => invoke('models:media', { refresh: refresh > 0 }), `media-models:${String(refresh)}`);
  const [query, setQuery] = useState('');
  const again = (): void => setRefresh((n) => n + 1);
  if (load.status === 'loading') {
    return (
      <Group title="Image, video and audio models">
        <LoadingState label="Looking for image, video and audio models…" className="py-16" />
      </Group>
    );
  }
  if (load.status === 'error') {
    return (
      <Group title="Image, video and audio models">
        <ErrorState title="Couldn't list the media models" message={load.message} onRetry={reload} className="py-16" />
      </Group>
    );
  }
  const sections = mediaSections(load.data, query);
  const any = mediaSections(load.data, '').some((s) => s.count > 0);
  const refreshButton = (
    <Button size="sm" variant="ghost" leading={<RefreshCw className="size-12" />} onClick={again}>
      Refresh
    </Button>
  );
  if (!any) {
    return (
      <Group title="Image, video and audio models" actions={refreshButton}>
        <p className="px-14 py-12 text-base text-fg-muted">
          None of your providers offers image, video or audio models. OpenRouter has them all with one key; OpenAI and Google have their own. Add one in Providers.
        </p>
      </Group>
    );
  }
  const shown = sections.filter((s) => s.providers.length > 0);
  return (
    <div className="flex flex-col gap-24">
      <div className="flex items-center gap-8">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-10 size-13 -translate-y-1/2 text-icon-muted" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Find an image, video or audio model"
            placeholder="Find an image, video or audio model"
            spellCheck={false}
            className="h-30 w-full rounded-md border border-input-border bg-input pr-8 pl-28 text-base text-fg transition-ui placeholder:text-fg-placeholder focus:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-0"
          />
        </label>
        {refreshButton}
      </div>
      {shown.length === 0 ? <p className="text-sm text-fg-muted">No image, video or audio model matches “{query.trim()}”.</p> : null}
      {shown.map((section) => (
        <Section key={section.kind} section={section} searching={query.trim().length > 0} />
      ))}
    </div>
  );
}
