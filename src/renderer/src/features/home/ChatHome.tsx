import { Ghost } from 'lucide-react';
import type { ImageBlock } from '@shared/schemas/messages';
import { Mark } from '../../brand/Mark';
import { IconButton } from '../../components/Button';
import { partOfDay } from '../../lib/format';
import { invoke } from '../../lib/ipc';
import { useNow } from '../../lib/time';
import { useApp } from '../../stores/app';
import { useNav } from '../../stores/nav';
import { useUi } from '../../stores/ui';
import { ChatModelMenu } from '../composer/ChatModelMenu';
import { Composer } from '../composer/Composer';
import { ViewHeader } from '../shell/ViewHeader';
import { useDefaults } from './useDefaults';

/** Chat home: time-of-day greeting and the composer that starts a chat (optionally incognito). */
export function ChatHome() {
  const name = useApp((s) => s.settings?.profile.name ?? '');
  const incognito = useUi((s) => s.incognito);
  const defaults = useDefaults();
  const now = new Date(useNow(60_000));

  const submit = async (text: string, images: ImageBlock[]): Promise<boolean> => {
    const summary = await invoke('sessions:create', {
      kind: 'chat',
      projectPath: null,
      useWorktree: false,
      branch: null,
      model: defaults.model?.ref ?? null,
      effort: defaults.effort,
      permissionMode: null,
      incognito,
      message: { text, images }
    });
    useUi.getState().setIncognito(false);
    useNav.getState().go({ name: 'session', id: summary.id });
    return true;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        actions={
          <IconButton
            label={incognito ? 'Turn off incognito chat' : 'Incognito chat (not saved)'}
            active={incognito}
            aria-pressed={incognito}
            onClick={() => useUi.getState().setIncognito(!incognito)}
          >
            <Ghost className="size-16" />
          </IconButton>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-24 pb-[14vh]">
        {incognito ? (
          <div className="flex flex-col items-center gap-8 text-center">
            <h1 className="flex items-center gap-12 font-serif text-greeting font-normal text-fg-strong">
              <Ghost className="size-32 text-icon" aria-hidden="true" />
              Incognito chat
            </h1>
            <p className="text-md text-fg-muted">This chat isn’t saved to your history and disappears when you close Graft.</p>
          </div>
        ) : (
          <h1 className="flex items-center gap-12 text-center font-serif text-greeting font-normal text-fg-strong">
            <Mark size={36} />
            <span>
              Good {partOfDay(now)}
              {name ? `, ${name}` : ''}
            </span>
          </h1>
        )}
        <Composer
          draftKey="home:chat"
          variant="chat"
          placeholder="How can I help you today?"
          supportsImages={defaults.model?.supportsVision ?? false}
          blockedReason={defaults.blockedReason}
          onSubmit={submit}
          autoFocus
          className="mt-28 w-full max-w-[var(--g-home-composer-width)]"
          rightControls={
            <ChatModelMenu model={defaults.model} effort={defaults.effort} onModel={defaults.setModel} onEffort={defaults.setEffort} />
          }
        />
      </div>
    </div>
  );
}
