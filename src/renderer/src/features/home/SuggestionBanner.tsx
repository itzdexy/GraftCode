import { useState } from 'react';
import { Lightbulb, X } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { shortcutText } from '../../lib/shortcuts';
import { useApp } from '../../stores/app';
import { reportError } from '../../stores/toasts';

export interface Tip {
  id: string;
  text: string;
  action: string;
  run: () => void;
}

interface SuggestionBannerProps {
  tips: Tip[];
}

/** One dismissible tip at a time; dismissed tips are remembered in settings. */
export function SuggestionBanner({ tips }: SuggestionBannerProps) {
  const dismissed = useApp((s) => s.settings?.ui.dismissedTips);
  const [hidden, setHidden] = useState<string[]>([]);
  const tip = tips.find((t) => !(dismissed ?? []).includes(t.id) && !hidden.includes(t.id));
  if (!tip) return null;

  const dismiss = (): void => {
    setHidden((h) => [...h, tip.id]);
    const next = [...(dismissed ?? []), tip.id].slice(-200);
    useApp
      .getState()
      .updateSettings({ ui: { dismissedTips: next } })
      .catch((e: unknown) => reportError("Couldn't save that", e));
  };

  return (
    <div role="note" className="flex h-[var(--g-banner-height)] items-center gap-10 rounded-md bg-raised pr-6 pl-8">
      <span className="flex size-20 shrink-0 items-center justify-center rounded-sm bg-strong text-icon" aria-hidden="true">
        <Lightbulb className="size-12" />
      </span>
      <p className="min-w-0 flex-1 truncate text-base font-medium text-fg-strong" title={tip.text}>
        {tip.text}
      </p>
      <button
        type="button"
        onClick={() => {
          tip.run();
          dismiss();
        }}
        className="h-24 shrink-0 rounded-md px-8 text-base font-medium text-fg-strong transition-ui hover:bg-hover"
      >
        {tip.action}
      </button>
      <IconButton label="Dismiss tip" size="xs" onClick={dismiss}>
        <X className="size-14" />
      </IconButton>
    </div>
  );
}

/** Tips for Code home, each tied to a real action. */
export function codeHomeTips(options: {
  isRepo: boolean;
  worktreeOn: boolean;
  hasProject: boolean;
  enableWorktree: () => void;
  prefill: (text: string) => void;
  openSearch: () => void;
  focusComposer: () => void;
  /** The tip from motionTip, when the system keeps Graft still. */
  motion: Tip | null;
}): Tip[] {
  const tips: Tip[] = options.motion ? [options.motion] : [];
  if (options.isRepo && !options.worktreeOn) {
    tips.push({
      id: 'code-worktree',
      text: 'Turn on worktree to run several sessions in one repo without them colliding.',
      action: 'Try it',
      run: options.enableWorktree
    });
  }
  if (options.hasProject) {
    tips.push({
      id: 'code-init',
      text: 'Run /init to write a GRAFT.md with this project’s conventions for future sessions.',
      action: 'Try it',
      run: () => options.prefill('/init')
    });
  }
  tips.push({
    id: 'code-cycle-mode',
    text: `Press ${shortcutText('cyclePermissionMode')} in the message box to switch permission modes.`,
    action: 'Try it',
    run: options.focusComposer
  });
  tips.push({
    id: 'code-search',
    text: `Press ${shortcutText('search')} to search every chat and session.`,
    action: 'Try it',
    run: options.openSearch
  });
  return tips;
}
