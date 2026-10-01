import { Dialog, DialogContent, DialogTrigger } from '../../components/Dialog';

/** Release notes shown from Code home's "What's new" link; newest first. */
export const RELEASE_NOTES: ReadonlyArray<{ version: string; date: string; items: string[] }> = [
  {
    version: '0.2.0',
    date: '2026-10-01',
    items: [
      'Meet Scion: the pixel sprout is now Graft’s icon in the taskbar, the tray and the installer, and its mark inside the app.',
      'Over 200 providers from an open model catalog, with a searchable picker, per-model effort levels and accurate costs.',
      'Settings → Privacy: ask providers not to train on your data, and incognito chats that stay off your computer.',
      'A real Bypass mode you switch on in Settings, plus Files and “Keep computer awake” in the session menu.',
      'Prompt caching for Claude models on OpenRouter, and session spend in the context popover.'
    ]
  },
  {
    version: '0.1.0',
    date: '2026-09-30',
    items: [
      'Code sessions with a real agent loop: read, edit, search, run commands and fetch pages, with a permission prompt for anything risky.',
      'Five permission modes, including Plan (read-only until you approve a plan) and Auto (low-risk actions run without asking).',
      'Git worktrees per session, hidden checkpoints before every turn, and rewind for files, conversation or both.',
      'Works with Anthropic, OpenAI, Google Gemini, OpenRouter, Ollama and any OpenAI-compatible endpoint.',
      'Taproot: a long-horizon effort mode that keeps going until the work is verified.'
    ]
  }
];

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
