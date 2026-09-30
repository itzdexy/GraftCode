import { useEffect } from 'react';
import type { ImageBlock } from '@shared/schemas/messages';
import { textOf } from '@shared/schemas/messages';
import { ErrorState, LoadingState } from '../../components/States';
import { invoke } from '../../lib/ipc';
import { useSessions, viewOf } from '../../stores/sessions';
import { Composer } from '../composer/Composer';
import { ViewHeader } from '../shell/ViewHeader';

/** A chat or code session: transcript and composer. */
export function SessionView({ sessionId }: { sessionId: string }) {
  const summary = useSessions((s) => s.summaries[sessionId]);
  const view = useSessions((s) => viewOf(s, sessionId));

  useEffect(() => {
    void useSessions.getState().open(sessionId);
  }, [sessionId]);

  if (!summary) return <ErrorState title="Session not found" message="It may have been deleted." />;

  const send = async (text: string, images: ImageBlock[]): Promise<boolean> => {
    await invoke('sessions:send', { id: sessionId, text, images });
    return true;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader>
        <span className="truncate text-base font-medium text-fg-strong">{summary.title}</span>
      </ViewHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="selectable mx-auto flex max-w-[var(--g-content-width)] flex-col gap-12 px-24 py-16 text-md">
          {view.loading && view.messages.length === 0 ? <LoadingState /> : null}
          {view.error ? <ErrorState message={view.error} onRetry={() => void useSessions.getState().open(sessionId)} /> : null}
          {view.messages.map((m) => (
            <p key={m.id} className={m.role === 'user' ? 'self-end rounded-md bg-raised px-12 py-8' : ''}>
              {textOf(m.content)}
            </p>
          ))}
          {view.streaming ? <p>{view.streaming.text}</p> : null}
        </div>
      </div>
      <div className="mx-auto w-full max-w-[calc(var(--g-content-width)+48px)] shrink-0 px-24 pb-8">
        <Composer
          draftKey={sessionId}
          variant="code"
          placeholder="Type / for commands"
          supportsImages
          busy={view.turnActive}
          onSubmit={send}
          onInterrupt={() => void invoke('sessions:interrupt', { id: sessionId })}
        />
      </div>
    </div>
  );
}
