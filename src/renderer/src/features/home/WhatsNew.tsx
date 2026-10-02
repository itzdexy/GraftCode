import { Dialog, DialogContent, DialogTrigger } from '../../components/Dialog';
import notes from './releaseNotes.json';

/**
 * Release notes shown from Code home's "What's new" link; newest first. The
 * release workflow publishes the same notes on GitHub (scripts/release-notes.mjs).
 */
export const RELEASE_NOTES: ReadonlyArray<{ version: string; date: string; items: string[] }> = notes;

export function WhatsNewLink() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="h-24 rounded-sm px-6 text-base text-link transition-ui hover:underline">
          What&apos;s new
        </button>
      </DialogTrigger>
      <DialogContent title="What's new in Graft" className="w-[min(560px,calc(100vw-48px))]">
        <div className="selectable flex flex-col gap-20">
          {RELEASE_NOTES.map((release) => (
            <section key={release.version} aria-label={`Version ${release.version}`}>
              <h3 className="text-base font-medium text-fg-strong">
                {release.version} <span className="font-normal text-fg-muted">· {release.date}</span>
              </h3>
              <ul className="mt-6 flex list-disc flex-col gap-4 pl-18 text-base text-fg-secondary">
                {release.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
