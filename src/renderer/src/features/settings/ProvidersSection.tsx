import { useEffect, useState } from 'react';
import { CircleCheck, ExternalLink, Eye, EyeOff, MoreHorizontal, Plus, TriangleAlert } from 'lucide-react';
import type { ProviderKind } from '@shared/schemas/common';
import type { ProviderPreset, ProviderSummary, VerifyResult } from '@shared/schemas/models';
import { Badge } from '../../components/Badge';
import { Button, IconButton } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';
import { Dialog, DialogContent } from '../../components/Dialog';
import { Switch, TextField } from '../../components/Field';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/Menu';
import { cn } from '../../lib/cn';
import { errorText, invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { reportError, useToasts } from '../../stores/toasts';
import { describeVerifyFailure } from '../onboarding/KeyStep';
import { ProviderPicker, type PickedProvider } from '../providers/ProviderPicker';
import { targetFor, urlPlaceholder, type ProviderTarget } from '../providers/targets';
import { ConfirmDialog, Group } from './common';
import { CatalogSection } from './CatalogSection';

type Failure = Extract<VerifyResult, { ok: false }>;
type Check = { state: 'idle' } | { state: 'checking' } | { state: 'ok'; modelCount: number; inputs: string } | { state: 'failed'; failure: Failure };

function failureText(target: Pick<ProviderTarget, 'name' | 'kind'>, baseUrl: string, failure: Failure): string {
  const described = describeVerifyFailure(target.name, target.kind, baseUrl, failure);
  return `${described.title} ${described.hint}${failure.message ? ` (${failure.message})` : ''}`;
}

function openLink(url: string | null): void {
  if (url) invoke('app:openExternal', { url }).catch((e: unknown) => reportError("Couldn't open the link", e));
}

/**
 * Add a provider (pick one of 200+ → details → verify) or edit one. Keys are
 * verified with a real request before they are saved, and never come back to
 * this screen.
 */
function ProviderDialog({ existing, onClose }: { existing: ProviderSummary | null; onClose: () => void }) {
  const environment = useApp((s) => s.environment);
  const plaintextAllowed = useApp((s) => s.settings?.security.allowPlaintextKeys === true);
  const presets = useApp((s) => s.presets);
  const [picked, setPicked] = useState<{ kind: ProviderKind; preset: ProviderPreset | null } | null>(null);
  const existingPreset = existing?.preset ? (presets?.find((p) => p.id === existing.preset) ?? null) : null;
  const choice = existing ? { kind: existing.kind, preset: existingPreset } : picked;
  const target = choice ? targetFor(choice.kind, choice.preset) : null;
  const [label, setLabel] = useState(existing?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const takesKey = target !== null && target.key !== 'none';
  const showsBaseUrl = target !== null && target.baseUrl !== 'hidden';
  const keyChanged = apiKey.trim().length > 0;
  const urlChanged = existing ? (baseUrl.trim() || null) !== existing.baseUrl : true;
  const placeholder = showsBaseUrl ? urlPlaceholder(baseUrl) : null;
  // New providers always verify; edits verify when the key changes (the stored key is never sent back here).
  const needsVerify = existing === null || keyChanged;
  const inputs = JSON.stringify({ kind: target?.kind, preset: target?.preset, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
  const verified = check.state === 'ok' && check.inputs === inputs;
  const storageBlocked = keyChanged && environment?.keyring === false && !plaintextAllowed;
  const canVerify =
    target !== null && (target.key !== 'required' || keyChanged || (existing?.hasKey ?? false)) && (target.baseUrl !== 'required' || baseUrl.trim().length > 0) && !placeholder;

  const pick = (row: PickedProvider): void => {
    const next = row.type === 'custom' ? { kind: 'openai-compatible' as const, preset: null } : { kind: row.preset.kind, preset: row.preset };
    const t = targetFor(next.kind, next.preset);
    setPicked(next);
    setBaseUrl(t.baseUrl === 'hidden' ? '' : (t.defaultBaseUrl ?? ''));
    setCheck({ state: 'idle' });
  };

  const verify = async (): Promise<void> => {
    if (!target) return;
    setCheck({ state: 'checking' });
    try {
      const result = await invoke('providers:verify', {
        kind: target.kind,
        preset: target.preset,
        baseUrl: showsBaseUrl ? baseUrl.trim() || null : null,
        apiKey: takesKey ? apiKey.trim() || null : null
      });
      setCheck(result.ok ? { state: 'ok', modelCount: result.modelCount, inputs } : { state: 'failed', failure: result });
    } catch (e) {
      setCheck({ state: 'failed', failure: { ok: false, code: 'unknown', message: errorText(e) } });
    }
  };

  const save = async (): Promise<void> => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const url = showsBaseUrl ? baseUrl.trim() || null : null;
      if (existing) {
        await invoke('providers:update', {
          id: existing.id,
          ...(label.trim() && label.trim() !== existing.label ? { label: label.trim() } : {}),
          ...(urlChanged && showsBaseUrl ? { baseUrl: url } : {}),
          ...(keyChanged ? { apiKey: apiKey.trim() } : {})
        });
        if (urlChanged && !keyChanged) {
          const result = await invoke('providers:test', { id: existing.id });
          if (!result.ok) useToasts.getState().push({ tone: 'error', title: 'Saved, but the connection failed', description: failureText(target, url ?? '', result) });
        }
      } else {
        await invoke('providers:add', { kind: target.kind, preset: target.preset, label: label.trim() || null, baseUrl: url, apiKey: takesKey ? apiKey.trim() || null : null });
      }
      useToasts.getState().push({ tone: 'success', title: existing ? 'Provider updated' : `${label.trim() || target.name} added` });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  if (!target) {
    return (
      <DialogContent
        title="Add a provider"
        description="Graft talks to each provider directly with your own key. Add the same provider twice to use several keys."
        className="w-[min(560px,calc(100vw-48px))]"
      >
        <ProviderPicker onPick={pick} autoFocus className="mb-12" />
      </DialogContent>
    );
  }

  const failure = check.state === 'failed' ? describeVerifyFailure(target.name, target.kind, baseUrl.trim() || target.defaultBaseUrl || '', check.failure) : null;
  const canSave = !busy && !storageBlocked && !placeholder && (!needsVerify || verified) && (existing !== null || canVerify);

  return (
    <DialogContent
      title={existing ? `Edit ${existing.label}` : `Add ${target.name}`}
      description={existing ? 'Leave the key empty to keep the one that is stored.' : 'Graft checks the details with a real request before saving. Keys are encrypted on this computer.'}
      footer={
        <>
          {existing ? null : (
            <Button variant="ghost" className="mr-auto" onClick={() => setPicked(null)} disabled={busy}>
              Back
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!canSave}>
            {busy ? 'Saving…' : existing ? 'Save' : 'Add provider'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-14 pb-8"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) void save();
          else if (needsVerify && canVerify && check.state !== 'checking') void verify();
        }}
      >
        <TextField label="Name" value={label} placeholder={target.name} hint="Shown in menus, e.g. “Work key”." maxLength={80} onChange={(e) => setLabel(e.target.value)} />
        {showsBaseUrl ? (
          <TextField
            label="Base URL"
            value={baseUrl}
            placeholder={target.defaultBaseUrl ?? 'http://localhost:8080/v1'}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setBaseUrl(e.target.value)}
            error={placeholder ? `Replace \${${placeholder}} with your own value.` : undefined}
          />
        ) : null}
        {takesKey ? (
          <TextField
            label={target.key === 'required' && !existing ? 'API key' : existing ? 'New API key (optional)' : 'API key (optional)'}
            value={apiKey}
            type={showKey ? 'text' : 'password'}
            placeholder={existing?.hasKey ? 'Stored key kept' : target.keyPlaceholder}
            spellCheck={false}
            autoComplete="off"
            inputClassName="font-mono text-sm"
            onChange={(e) => setApiKey(e.target.value)}
            hint={
              target.envVars.length > 0 || target.keyHelpUrl ? (
                <span className="flex flex-wrap items-center gap-x-8">
                  {target.envVars.length > 0 ? <span>Usually stored as {target.envVars.join(' or ')}.</span> : null}
                  {target.keyHelpUrl ? (
                    <button type="button" className="inline-flex items-center gap-4 text-link hover:underline" onClick={() => openLink(target.keyHelpUrl)}>
                      Get a key <ExternalLink className="size-12" aria-hidden="true" />
                    </button>
                  ) : null}
                </span>
              ) : undefined
            }
            trailing={
              <IconButton label={showKey ? 'Hide key' : 'Show key'} size="xs" onClick={() => setShowKey(!showKey)}>
                {showKey ? <EyeOff className="size-14" /> : <Eye className="size-14" />}
              </IconButton>
            }
          />
        ) : null}
        {storageBlocked ? (
          <p className="flex items-start gap-8 rounded-md border border-border bg-warning-bg px-10 py-8 text-sm text-warning-fg">
            <TriangleAlert className="mt-1 size-14 shrink-0" aria-hidden="true" />
            This system has no secure key storage. Allow unencrypted keys in Settings → Data to save one.
          </p>
        ) : null}
        {needsVerify ? (
          <div className="flex items-center gap-12">
            <Button type="button" variant="secondary" onClick={() => void verify()} disabled={!canVerify || check.state === 'checking'}>
              {check.state === 'checking' ? 'Checking…' : 'Verify'}
            </Button>
            <div className="min-w-0 flex-1 text-base" aria-live="polite">
              {check.state === 'checking' ? (
                <span className="flex items-center gap-6 text-fg-muted">
                  <Spinner size={12} label="Checking" /> Contacting {target.name}…
                </span>
              ) : null}
              {check.state === 'ok' && verified ? (
                <span className="flex items-center gap-6 text-fg-secondary">
                  <CircleCheck className="size-14 text-success" aria-hidden="true" />
                  Connected. {check.modelCount} {check.modelCount === 1 ? 'model' : 'models'} available.
                </span>
              ) : null}
              {check.state === 'ok' && !verified ? <span className="text-fg-muted">Details changed. Verify again.</span> : null}
            </div>
          </div>
        ) : null}
        {failure && check.state === 'failed' ? (
          <div role="alert" className="rounded-md border border-border bg-danger-bg px-12 py-10">
            <p className="text-base font-medium text-danger">{failure.title}</p>
            <p className="mt-2 text-sm text-fg-secondary">{failure.hint}</p>
            {check.failure.message ? <p className="selectable mt-6 text-sm break-words text-fg-muted">{check.failure.message}</p> : null}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true" />
      </form>
    </DialogContent>
  );
}

function ProviderRow({ provider, onEdit, onRemove }: { provider: ProviderSummary; onEdit: () => void; onRemove: () => void }) {
  const defaultModelProvider = useApp((s) => s.settings?.defaults.model?.providerId ?? null);
  const [testing, setTesting] = useState(false);
  const preset = useApp((s) => (provider.preset ? (s.presets?.find((p) => p.id === provider.preset) ?? null) : null));
  const target = targetFor(provider.kind, preset);

  const test = async (): Promise<void> => {
    setTesting(true);
    try {
      const result = await invoke('providers:test', { id: provider.id });
      if (result.ok) useToasts.getState().push({ tone: 'success', title: `${provider.label} is connected`, description: `${result.modelCount} ${result.modelCount === 1 ? 'model' : 'models'} available.` });
      else useToasts.getState().push({ tone: 'error', title: `${provider.label} didn't answer`, description: failureText(target, provider.baseUrl ?? '', result) });
    } catch (e) {
      reportError("Couldn't test the provider", e);
    } finally {
      setTesting(false);
    }
  };

  const setEnabled = (enabled: boolean): void => {
    invoke('providers:update', { id: provider.id, enabled }).catch((e: unknown) => reportError("Couldn't change the provider", e));
  };

  const setDefault = (): void => {
    invoke('providers:setDefault', { id: provider.id }).catch((e: unknown) => reportError("Couldn't change the default provider", e));
  };

  return (
    <li className="flex items-center gap-12 px-14 py-10" aria-label={provider.label}>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-6 text-base text-fg">
          <span className="truncate">{provider.label}</span>
          {provider.label !== target.name ? <span className="text-sm text-fg-muted">{target.name}</span> : null}
          {provider.isDefault ? <Badge tone="accent">Default</Badge> : null}
          {defaultModelProvider === provider.id && !provider.isDefault ? <Badge>Default model</Badge> : null}
        </p>
        <p className="mt-2 truncate text-sm text-fg-muted">
          {[provider.baseUrl, target.key === 'none' ? 'No key needed' : provider.hasKey ? 'Key stored' : target.key === 'optional' ? 'No key (optional)' : 'No key'].filter(Boolean).join(' · ')}
        </p>
      </div>
      {testing ? <Spinner size={12} label="Testing" /> : null}
      <Switch label={`Use ${provider.label}`} checked={provider.enabled} onChange={setEnabled} />
      <Menu>
        <MenuTrigger asChild>
          <IconButton label={`Options for ${provider.label}`} size="sm">
            <MoreHorizontal className="size-14" />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={() => void test()}>Test connection</MenuItem>
          <MenuItem onSelect={onEdit}>Edit</MenuItem>
          {provider.isDefault ? null : <MenuItem onSelect={setDefault}>Make default</MenuItem>}
          <MenuSeparator />
          <MenuItem danger onSelect={onRemove}>
            Remove
          </MenuItem>
        </MenuContent>
      </Menu>
    </li>
  );
}

export function ProvidersSection() {
  const providers = useApp((s) => s.providers);
  useEffect(() => {
    useApp
      .getState()
      .loadPresets()
      .catch((e: unknown) => reportError("Couldn't load the provider list", e));
  }, []);
  const [dialog, setDialog] = useState<{ provider: ProviderSummary | null } | null>(null);
  const [removing, setRemoving] = useState<ProviderSummary | null>(null);

  return (
    <div className="flex flex-col gap-24">
      <CatalogSection />
      <Group
        description="Each provider is a key or endpoint. Models from every enabled provider appear in the model menus."
        actions={
          <Button size="sm" variant="secondary" leading={<Plus className="size-14" />} onClick={() => setDialog({ provider: null })}>
            Add provider
          </Button>
        }
      >
        {providers.length === 0 ? (
          <p className="px-14 py-12 text-base text-fg-muted">No providers yet. Add one to start sessions.</p>
        ) : (
          <ul aria-label="Providers" className={cn('flex flex-col divide-y divide-border-subtle')}>
            {providers.map((p) => (
              <ProviderRow key={p.id} provider={p} onEdit={() => setDialog({ provider: p })} onRemove={() => setRemoving(p)} />
            ))}
          </ul>
        )}
      </Group>

      <Dialog open={dialog !== null} onOpenChange={(open) => (open ? undefined : setDialog(null))}>
        {dialog ? <ProviderDialog key={dialog.provider?.id ?? 'new'} existing={dialog.provider} onClose={() => setDialog(null)} /> : null}
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title={`Remove ${removing?.label ?? 'provider'}?`}
        description="Its stored key is deleted. Sessions that use its models ask you to pick another model."
        confirmLabel="Remove"
        danger
        onConfirm={async () => {
          if (removing) await invoke('providers:remove', { id: removing.id });
        }}
      />
    </div>
  );
}
