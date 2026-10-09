import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { Switch } from '../../components/Field';
import { errorText, invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { reportError } from '../../stores/toasts';
import { Group } from './common';

export function CatalogSection() {
  const status = useApp((s) => s.catalogStatus);
  const prefs = useApp((s) => s.settings?.modelCatalog);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void invoke('catalog:status').then((s) => useApp.getState().catalogChanged(s)).catch((e: unknown) => setError(errorText(e))); }, []);
  const refresh = async (): Promise<void> => {
    setRefreshing(true); setError(null);
    try {
      useApp.getState().catalogChanged(await invoke('catalog:refresh'));
      await useApp.getState().loadModels(true);
    } catch (e) { setError(errorText(e)); }
    finally { setRefreshing(false); }
  };
  return <Group title="Model catalog" description="Refresh model metadata from Models.dev without an application update. Your keys and project files are never included."
    actions={<Button size="sm" variant="secondary" disabled={refreshing || status?.state === 'refreshing'} onClick={() => void refresh()}>Refresh catalog</Button>}>
    <div className="flex flex-col gap-12 px-14 py-12">
      <Switch label="Automatically refresh model metadata" checked={prefs?.enabled ?? true}
        onChange={(enabled) => { void useApp.getState().updateSettings({ modelCatalog: { enabled } }).catch((e: unknown) => reportError("Couldn't change catalog settings", e)); }} />
      <label className="flex items-center gap-8 text-base">Refresh interval
        <select aria-label="Model catalog refresh interval" className="rounded-md border border-border bg-surface px-8 py-4" value={prefs?.intervalHours ?? 24}
          onChange={(e) => { void useApp.getState().updateSettings({ modelCatalog: { intervalHours: Number(e.target.value) } }).catch((err: unknown) => reportError("Couldn't change catalog settings", err)); }}>
          {[1, 6, 12, 24, 48, 168].map((hours) => <option key={hours} value={hours}>Every {hours} hours</option>)}
        </select>
      </label>
      <p role="status" className="text-sm text-fg-muted">{status?.state === 'refreshing' ? 'Refreshing catalog…' : status?.verifiedAt ? `Last validated: ${new Date(status.verifiedAt).toLocaleString()}` : 'Using the catalog bundled with Graft.'}</p>
      {status?.state === 'current' ? <p className="text-sm text-fg-muted">{status.changes.added} added · {status.changes.changed} changed · {status.changes.deprecated} deprecated · {status.changes.omitted} omitted. Omission does not confirm retirement.</p> : null}
      {error || status?.error ? <p role="alert" className="text-sm text-danger">{error ?? status?.error} Previously validated metadata remains available. Retry with Refresh catalog.</p> : null}
    </div>
  </Group>;
}
