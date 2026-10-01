import { useState } from 'react';
import type { MemoryInfoView } from '@shared/schemas/customize';
import { Button } from '../../components/Button';
import { ErrorState, LoadingState } from '../../components/States';
import { invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { reportError, useToasts } from '../../stores/toasts';
import { MONO_AREA, Section } from './shared';

function MemoryEditor({ memory, projectPath, onSaved }: { memory: MemoryInfoView; projectPath: string | null; onSaved: () => void }) {
  const [text, setText] = useState(memory.content);
  const [busy, setBusy] = useState(false);
  const dirty = text !== memory.content;
  const save = (): void => {
    setBusy(true);
    invoke('customize:saveMemory', { scope: memory.scope, projectPath, content: text })
      .then(() => {
        useToasts.getState().push({ tone: 'success', title: 'Saved', description: memory.path });
        onSaved();
      })
      .catch((e: unknown) => reportError("Couldn't save", e))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline gap-8">
        <h3 className="text-base font-medium text-fg-secondary">{memory.scope === 'user' ? 'For all projects' : 'For this project'}</h3>
        <span className="selectable min-w-0 truncate font-mono text-2xs text-fg-faint">{memory.path}</span>
      </div>
      {memory.fallback ? (
        <p className="text-sm text-fg-muted">
          No GRAFT.md yet, so Graft reads <span className="font-mono">{memory.fallback}</span>. Saving here creates GRAFT.md, which takes precedence.
        </p>
      ) : null}
      <textarea
        aria-label={memory.scope === 'user' ? 'Instructions for all projects' : 'Instructions for this project'}
        className={MONO_AREA}
        rows={10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={memory.scope === 'user' ? '- I prefer small commits with clear messages.\n- Use pnpm, not npm.' : '# Project notes\n\n- Run `npm test` before finishing.\n- API handlers live in src/api.'}
      />
      <div className="flex justify-end">
        <Button size="sm" variant="primary" disabled={!dirty || busy} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

export function MemorySection({ projectPath }: { projectPath: string | null }) {
  const { load, reload } = useLoad(() => invoke('customize:memory', { projectPath }), projectPath ?? '');
  return (
    <Section title="Memory" description="Standing instructions in GRAFT.md files. Graft reads them at the start of every session; folders deeper in a project can have their own.">
      {load.status === 'loading' ? <LoadingState /> : null}
      {load.status === 'error' ? <ErrorState message={load.message} onRetry={reload} /> : null}
      {load.status === 'ready' ? load.data.map((m) => <MemoryEditor key={`${m.path}:${m.content.length}`} memory={m} projectPath={projectPath} onSaved={reload} />) : null}
    </Section>
  );
}
