import type { DetectedServer, ProviderSummary } from '@shared/schemas/models';
import { Button } from '../../components/Button';
import { invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';

/** Shown when a search of this computer finds no model server. */
export const NO_SERVER_FOUND = 'No model server answered on this computer. Start Ollama, LM Studio or llama-server and try again.';

/**
 * Adds a server found on this computer as a provider. It needs no key, and it
 * already answered with its model list, so there is nothing to verify first.
 * The provider list is read back so the next screen sees the new provider.
 */
export async function addFoundServer(server: DetectedServer): Promise<ProviderSummary> {
  const provider = await invoke('providers:add', { kind: server.kind, preset: server.preset, label: server.name, baseUrl: server.baseUrl, apiKey: null });
  useApp.getState().setProviders(await invoke('providers:list'));
  return provider;
}

/** The model servers found on this computer: name, address and model count, each with a button that adds it. */
export function FoundServerList({ servers, adding, onAdd }: { servers: DetectedServer[]; adding: string | null; onAdd: (server: DetectedServer) => void }) {
  return (
    <ul aria-label="Servers on this computer" className="flex flex-col divide-y divide-border-subtle">
      {servers.map((server) => (
        <li key={server.baseUrl} aria-label={server.name} className="flex items-center gap-12 px-14 py-10">
          <div className="min-w-0 flex-1">
            <p className="truncate text-base text-fg">{server.name}</p>
            <p className="selectable mt-2 truncate text-sm text-fg-muted">
              {server.baseUrl} · {server.models} {server.models === 1 ? 'model' : 'models'}
            </p>
          </div>
          <Button size="sm" variant="secondary" aria-label={`Add ${server.name}`} disabled={adding !== null} onClick={() => onAdd(server)}>
            {adding === server.baseUrl ? 'Adding…' : 'Add'}
          </Button>
        </li>
      ))}
    </ul>
  );
}
