import { create } from 'zustand';
import { Copy } from 'lucide-react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { ErrorState, LoadingState } from '../../components/States';
import { invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { reportError, useToasts } from '../../stores/toasts';

interface SystemPromptState {
  sessionId: string | null;
  open: (sessionId: string) => void;
  close: () => void;
}

/** Which session's system prompt is on screen (opened from the session menu, /system or the command palette). */
export const useSystemPrompt = create<SystemPromptState>((set) => ({
  sessionId: null,
  open: (sessionId) => set({ sessionId }),
  close: () => set({ sessionId: null })
}));

function PromptBody({ sessionId }: { sessionId: string }) {
  const { load, reload } = useLoad(() => invoke('sessions:systemPrompt', { id: sessionId }), sessionId);
  const close = useSystemPrompt((s) => s.close);
  const ready = load.status === 'ready' ? load.data : null;

  const copy = (): void => {
    if (!ready) return;
    navigator.clipboard.writeText(ready.system).then(
      () => useToasts.getState().push({ tone: 'success', title: 'System prompt copied' }),
      (error: unknown) => reportError("Couldn't copy to the clipboard", error)
    );
  };

  return (
    <DialogContent
      title="System prompt"
      description="What Graft sends to the model before your messages: its instructions, the session's environment, project notes and your personalization."
      className="w-[min(860px,calc(100vw-48px))]"
      footer={
        <>
          <Button variant="ghost" leading={<Copy className="size-14" />} disabled={!ready} onClick={copy}>
            Copy
          </Button>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      {load.status === 'loading' ? <LoadingState className="py-24" /> : null}
      {load.status === 'error' ? <ErrorState title="Couldn't build the system prompt" message={load.message} onRetry={reload} className="py-24" /> : null}
      {ready ? (
        <div className="flex flex-col gap-10">
          <p className="text-sm text-fg-muted">
            {ready.model} · about {Math.round(ready.system.length / 4).toLocaleString()} tokens · {ready.tools.length} {ready.tools.length === 1 ? 'tool' : 'tools'}
          </p>
          <pre className="selectable max-h-[52vh] overflow-auto rounded-md border border-border bg-sunken p-12 font-mono text-[length:var(--g-code-font-size)] leading-[1.5] break-words whitespace-pre-wrap text-fg-secondary">
            {ready.system}
          </pre>
          {ready.tools.length > 0 ? (
            <ul aria-label="Tools" className="flex flex-wrap gap-4">
              {[...ready.tools].sort().map((tool) => (
                <li key={tool}>
                  <Badge className="font-mono text-xs">{tool}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </DialogContent>
  );
}

/** Mounted once in the app shell. */
export function SystemPromptDialog() {
  const sessionId = useSystemPrompt((s) => s.sessionId);
  const close = useSystemPrompt((s) => s.close);
  return (
    <Dialog open={sessionId !== null} onOpenChange={(open) => (open ? undefined : close())}>
      {sessionId ? <PromptBody sessionId={sessionId} /> : null}
    </Dialog>
  );
}
