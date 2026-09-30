import { useEffect, useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ImageBlock } from '@shared/schemas/messages';
import type { SessionSummary } from '@shared/schemas/sessions';
import { Mark } from '../../brand/Mark';
import { Mascot } from '../../brand/Mascot';
import { LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { useNav } from '../../stores/nav';
import { useSessions } from '../../stores/sessions';
import { useUi, type CodeContext } from '../../stores/ui';
import { Composer } from '../composer/Composer';
import { ContextUsage } from '../composer/ContextUsage';
import { EffortPopover } from '../composer/EffortPopover';
import { ModelQuickMenu } from '../composer/ModelQuickMenu';
import { nextMode, PermissionModeMenu } from '../composer/PermissionModeMenu';
import { homeSessions } from '../shell/sessionLists';
import { statusText } from '../shell/SessionStatus';
import { ViewHeader } from '../shell/ViewHeader';
import { initialCodeContext } from './codeContext';
import { ContextChips, pickProjectFolder, useBranches } from './ContextChips';
import { codeHomeTips, SuggestionBanner } from './SuggestionBanner';
import { useDefaults } from './useDefaults';
import { WhatsNewLink } from './WhatsNew';

const HOME_LIST_LIMIT = 8;
const DRAFT_KEY = 'home:code';

const STATUS_TONE: Record<string, string> = {
  'Needs input': 'text-amber-fg',
  Error: 'text-danger',
  Running: 'text-fg-muted',
  Finished: 'text-amber-fg'
};

function HomeSessionRow({ session }: { session: SessionSummary }) {
  const status = statusText(session);
  const showStatus = status !== 'Idle';
  return (
    <li>
      <button
        type="button"
        onClick={() => useNav.getState().go({ name: 'session', id: session.id })}
        className="flex h-[var(--g-session-row-height)] w-full items-center gap-10 rounded-md bg-raised px-10 text-left transition-ui hover:bg-hover"
      >
        {showStatus ? (
          <span className={cn('flex shrink-0 items-center gap-6 text-base', STATUS_TONE[status])}>
            <span className="size-4 rounded-full bg-current" aria-hidden="true" />
            {status}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-base font-medium text-fg-strong">{session.title}</span>
        {session.projectName ? <span className="max-w-[30%] shrink truncate text-sm text-fg-muted">{session.projectName}</span> : null}
        <span className="shrink-0 text-sm text-fg-muted">{relativeTime(session.updatedAt)}</span>
        <ChevronRight className="size-16 shrink-0 text-icon-muted" aria-hidden="true" />
      </button>
    </li>
  );
}

function useCodeContext(): CodeContext | null {
  const settings = useApp((s) => s.settings);
  const projects = useApp((s) => s.projects);
  const context = useUi((s) => s.codeContext);
  useEffect(() => {
    if (!context && settings) useUi.getState().setCodeContext(initialCodeContext(settings, projects));
  }, [context, settings, projects]);
  return context;
}

/** Code home: greeting, sessions needing attention, and the composer that starts a session. */
export function CodeHome() {
  const name = useApp((s) => s.settings?.profile.name ?? '');
  const justOnboarded = useApp((s) => s.justOnboarded);
  const summaries = useSessions((s) => s.summaries);
  const loaded = useSessions((s) => s.loaded);
  const defaults = useDefaults();
  const context = useCodeContext();
  const branches = useBranches(context?.projectPath);
  const isRepo = branches.status === 'ready' && branches.list.isRepo;

  const sessions = useMemo(() => homeSessions(Object.values(summaries), 'code', HOME_LIST_LIMIT), [summaries]);

  const submit = async (text: string, images: ImageBlock[]): Promise<boolean> => {
    let ctx = useUi.getState().codeContext;
    if (!ctx?.projectPath) {
      const picked = await pickProjectFolder();
      if (!picked) return false;
      ctx = useUi.getState().codeContext;
      if (!ctx?.projectPath) return false;
    }
    const summary = await invoke('sessions:create', {
      kind: 'code',
      projectPath: ctx.projectPath,
      useWorktree: ctx.useWorktree,
      branch: ctx.useWorktree ? ctx.branch : null,
      model: defaults.model?.ref ?? null,
      effort: defaults.effort,
      permissionMode: defaults.permissionMode,
      incognito: false,
      message: { text, images }
    });
    useUi.getState().setCodeContext({ ...ctx, branch: null });
    useNav.getState().go({ name: 'session', id: summary.id });
    return true;
  };

  const tips = context
    ? codeHomeTips({
        isRepo,
        worktreeOn: context.useWorktree,
        hasProject: context.projectPath !== null,
        enableWorktree: () => useUi.getState().setCodeContext({ ...context, useWorktree: true }),
        prefill: (text) => {
          useUi.getState().setDraft(DRAFT_KEY, text);
          useUi.getState().focusComposer?.();
        },
        openSearch: () => useUi.getState().setSearchOpen(true),
        focusComposer: () => useUi.getState().focusComposer?.()
      })
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader actions={<WhatsNewLink />} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[calc(var(--g-content-width)+48px)] px-24 pt-16 pb-24">
          <h1 className="flex items-center gap-10 text-xl font-medium text-fg-strong">
            <Mark size={20} />
            <span className="truncate">
              {justOnboarded ? 'Welcome' : 'Welcome back'}
              {name ? `, ${name}` : ''}
            </span>
          </h1>
          <section aria-labelledby="home-sessions" className="mt-40">
            <h2 id="home-sessions" className="mb-8 text-base font-medium text-fg">
              Sessions
            </h2>
            {!loaded ? <LoadingState label="Loading sessions…" className="justify-start py-8" /> : null}
            {loaded && sessions.length === 0 ? (
              <p className="text-base text-fg-muted">No sessions yet. Describe a task below and Graft starts one in the chosen folder.</p>
            ) : null}
            <ul className="flex flex-col gap-[var(--g-session-row-gap)]">
              {sessions.map((s) => (
                <HomeSessionRow key={s.id} session={s} />
              ))}
            </ul>
          </section>
        </div>
      </div>
      <div className="mx-auto w-full max-w-[calc(var(--g-content-width)+48px)] shrink-0 px-24 pb-8">
        {context ? (
          <div className="mb-8 flex items-end gap-8">
            <ContextChips context={context} branches={branches} className="flex-1" />
            <Mascot pixel={3} className="mr-8 shrink-0" />
          </div>
        ) : null}
        <div className="mb-8">
          <SuggestionBanner tips={tips} />
        </div>
        <Composer
          draftKey={DRAFT_KEY}
          variant="code"
          placeholder="Describe a task or ask a question"
          supportsImages={defaults.model?.supportsVision ?? false}
          blockedReason={defaults.blockedReason}
          onSubmit={submit}
          onCyclePermission={() => defaults.setPermissionMode(nextMode(defaults.permissionMode))}
          autoFocus
          leftControls={<PermissionModeMenu value={defaults.permissionMode} onChange={defaults.setPermissionMode} />}
          rightControls={
            <>
              <ModelQuickMenu current={defaults.model} onSelect={defaults.setModel} emptyLabel={defaults.blockedReason ?? 'No model'} />
              {defaults.model && defaults.effort ? (
                <EffortPopover model={defaults.model} value={defaults.effort} onChange={defaults.setEffort} />
              ) : null}
              <ContextUsage used={0} limit={defaults.model?.contextWindow ?? 0} />
            </>
          }
        />
      </div>
    </div>
  );
}
