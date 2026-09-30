import { useState } from 'react';
import { CircleCheck, ExternalLink, Eye, EyeOff, TriangleAlert } from 'lucide-react';
import type { ProviderKind } from '@shared/schemas/common';
import type { VerifyResult } from '@shared/schemas/models';
import { PROVIDER_KIND_INFO } from '@shared/providerKinds';
import { Button, IconButton } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';
import { Checkbox, TextField } from '../../components/Field';
import { errorText, invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { reportError } from '../../stores/toasts';
import { StepLayout, type StepProps } from './StepLayout';

type Failure = Extract<VerifyResult, { ok: false }>;

/** Plain-language explanation for each verification failure. */
export function describeVerifyFailure(kind: ProviderKind, baseUrl: string, failure: Failure): { title: string; hint: string } {
  const name = PROVIDER_KIND_INFO[kind].name;
  switch (failure.code) {
    case 'auth':
      return { title: `${name} rejected this key.`, hint: 'Check that you copied the whole key and that it is still active.' };
    case 'rate_limit':
      return { title: `${name} is rate limiting this key.`, hint: 'Wait a minute, then verify again.' };
    case 'network':
      return kind === 'ollama'
        ? { title: `Couldn't reach Ollama at ${baseUrl}.`, hint: 'Make sure Ollama is running, then verify again.' }
        : { title: `Couldn't reach ${name}.`, hint: 'Check your internet connection, proxy or firewall.' };
    case 'bad_base_url':
    case 'not_found':
      return { title: 'No compatible API answered at that address.', hint: 'Check the base URL. OpenAI-compatible servers usually end in /v1.' };
    case 'bad_request':
      return { title: `${name} rejected the check request.`, hint: 'The details below come from the provider.' };
    case 'server':
    case 'overloaded':
      return { title: `${name} had a problem answering.`, hint: 'This is usually temporary. Try again in a moment.' };
    case 'context_length':
    case 'aborted':
    case 'unknown':
      return { title: 'Verification failed.', hint: 'The details below may help.' };
  }
}

type Status = { state: 'idle' } | { state: 'checking' } | { state: 'ok'; modelCount: number; inputs: string } | { state: 'failed'; failure: Failure };

export function KeyStep({ onNext, onBack }: StepProps) {
  const settings = useApp((s) => s.settings);
  const providers = useApp((s) => s.providers);
  const environment = useApp((s) => s.environment);
  const kind = (settings?.onboarding.providerKind ?? 'anthropic') as ProviderKind;
  const info = PROVIDER_KIND_INFO[kind];
  const existing = providers.find((p) => p.id === settings?.onboarding.providerId && p.kind === kind) ?? null;

  const [editing, setEditing] = useState(existing === null);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? info.defaultBaseUrl ?? '');
  const [status, setStatus] = useState<Status>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsKey = info.key === 'required';
  const takesKey = info.key !== 'none';
  const showsBaseUrl = info.baseUrl !== 'hidden';
  const keyringMissing = environment?.keyring === false;
  const plaintextAllowed = settings?.security.allowPlaintextKeys === true;
  const willStoreKey = takesKey && apiKey.trim().length > 0;
  const storageBlocked = willStoreKey && keyringMissing && !plaintextAllowed;

  const inputs = JSON.stringify({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
  const verified = status.state === 'ok' && status.inputs === inputs;
  const canVerify = (!needsKey || apiKey.trim().length > 0) && (info.baseUrl !== 'required' || baseUrl.trim().length > 0);

  const verify = async (): Promise<void> => {
    setStatus({ state: 'checking' });
    try {
      const result = await invoke('providers:verify', {
        kind,
        baseUrl: showsBaseUrl ? baseUrl.trim() || null : null,
        apiKey: takesKey ? apiKey.trim() || null : null
      });
      setStatus(result.ok ? { state: 'ok', modelCount: result.modelCount, inputs } : { state: 'failed', failure: result });
    } catch (e) {
      setStatus({ state: 'failed', failure: { ok: false, code: 'unknown', message: errorText(e) } });
    }
  };

  const allowPlaintext = async (allow: boolean): Promise<void> => {
    try {
      await useApp.getState().updateSettings({ security: { allowPlaintextKeys: allow } });
    } catch (e) {
      reportError("Couldn't change key storage", e);
    }
  };

  const submit = async (): Promise<void> => {
    if (!editing) {
      setBusy(true);
      try {
        await onNext();
      } catch (e) {
        setError(errorText(e));
        setBusy(false);
      }
      return;
    }
    if (!verified || storageBlocked) return;
    setBusy(true);
    setError(null);
    try {
      const url = showsBaseUrl ? baseUrl.trim() || null : null;
      const key = takesKey ? apiKey.trim() || null : null;
      const provider = existing
        ? await invoke('providers:update', { id: existing.id, baseUrl: url, ...(key ? { apiKey: key } : {}) })
        : await invoke('providers:add', { kind, label: null, baseUrl: url, apiKey: key });
      const next = await invoke('settings:update', { onboarding: { providerId: provider.id } });
      useApp.getState().setSettings(next);
      setApiKey('');
      await onNext();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const title = kind === 'ollama' ? 'Connect to Ollama' : kind === 'openai-compatible' ? 'Connect your endpoint' : `Add your ${info.name} key`;

  if (!editing && existing) {
    return (
      <StepLayout title={title} onSubmit={submit} onBack={onBack} primaryLabel="Continue" busy={busy} error={error}>
        <div className="flex items-center gap-10 rounded-lg border border-border bg-surface px-14 py-12">
          <CircleCheck className="size-16 shrink-0 text-success" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-base text-fg-strong">{existing.label} is connected and verified.</p>
            {existing.baseUrl ? <p className="selectable truncate text-sm text-fg-muted">{existing.baseUrl}</p> : null}
          </div>
          <Button size="sm" variant="secondary" data-autofocus onClick={() => setEditing(true)}>
            {takesKey ? 'Replace key' : 'Change'}
          </Button>
        </div>
      </StepLayout>
    );
  }

  const failure = status.state === 'failed' ? describeVerifyFailure(kind, baseUrl.trim() || info.defaultBaseUrl || '', status.failure) : null;

  return (
    <StepLayout
      title={title}
      description={
        <span>
          {needsKey ? 'Paste an API key. Graft checks it with a real request before saving it, encrypted, on this computer.' : null}
          {kind === 'ollama' ? 'Graft uses the models you have pulled in Ollama. No key needed.' : null}
          {kind === 'openai-compatible' ? 'Any server that implements the OpenAI chat completions API, local or hosted.' : null}
          {info.keyHelpUrl ? (
            <button
              type="button"
              className="ml-6 inline-flex items-center gap-4 text-link hover:underline"
              onClick={() => {
                if (info.keyHelpUrl) invoke('app:openExternal', { url: info.keyHelpUrl }).catch((e: unknown) => reportError("Couldn't open the link", e));
              }}
            >
              Get a key <ExternalLink className="size-12" aria-hidden="true" />
            </button>
          ) : null}
        </span>
      }
      onSubmit={submit}
      onBack={onBack}
      primaryLabel="Continue"
      primaryDisabled={!verified || storageBlocked}
      busy={busy}
      error={error}
    >
      <div className="flex max-w-[440px] flex-col gap-16">
        {showsBaseUrl ? (
          <TextField
            label="Base URL"
            value={baseUrl}
            placeholder={info.defaultBaseUrl ?? 'http://localhost:8080/v1'}
            spellCheck={false}
            autoComplete="off"
            data-autofocus={kind === 'ollama' || kind === 'openai-compatible' ? true : undefined}
            onChange={(e) => setBaseUrl(e.target.value)}
            hint={kind === 'ollama' ? 'Leave as is unless Ollama runs elsewhere.' : undefined}
          />
        ) : null}
        {takesKey ? (
          <TextField
            label={needsKey ? 'API key' : 'API key (optional)'}
            value={apiKey}
            type={showKey ? 'text' : 'password'}
            placeholder={info.keyPlaceholder}
            spellCheck={false}
            autoComplete="off"
            data-autofocus={needsKey ? true : undefined}
            onChange={(e) => setApiKey(e.target.value)}
            inputClassName="font-mono text-sm"
            trailing={
              <IconButton label={showKey ? 'Hide key' : 'Show key'} size="xs" onClick={() => setShowKey(!showKey)}>
                {showKey ? <EyeOff className="size-14" /> : <Eye className="size-14" />}
              </IconButton>
            }
          />
        ) : null}

        {keyringMissing && takesKey ? (
          <div className="flex flex-col gap-8 rounded-md border border-border bg-warning-bg px-12 py-10">
            <p className="flex items-start gap-8 text-sm text-warning-fg">
              <TriangleAlert className="mt-1 size-14 shrink-0" aria-hidden="true" />
              This system has no secure key storage (OS keyring), so Graft can&apos;t encrypt your key. It won&apos;t store keys
              unencrypted unless you allow it.
            </p>
            <Checkbox
              label="Store keys unencrypted on this computer"
              checked={plaintextAllowed}
              onChange={(e) => void allowPlaintext(e.target.checked)}
            />
          </div>
        ) : null}

        <div className="flex items-center gap-12">
          <Button variant="secondary" onClick={() => void verify()} disabled={!canVerify || status.state === 'checking'}>
            {status.state === 'checking' ? 'Checking…' : 'Verify'}
          </Button>
          <div className="min-w-0 flex-1 text-base" aria-live="polite">
            {status.state === 'checking' ? (
              <span className="flex items-center gap-6 text-fg-muted">
                <Spinner size={12} label="Checking" /> Contacting {info.name}…
              </span>
            ) : null}
            {status.state === 'ok' && verified ? (
              <span className="flex items-center gap-6 text-fg-secondary">
                <CircleCheck className="size-14 text-success" aria-hidden="true" />
                Connected. {status.modelCount} {status.modelCount === 1 ? 'model' : 'models'} available.
              </span>
            ) : null}
            {status.state === 'ok' && !verified ? <span className="text-fg-muted">Details changed. Verify again.</span> : null}
          </div>
        </div>
        {failure && status.state === 'failed' ? (
          <div role="alert" className="rounded-md border border-border bg-danger-bg px-12 py-10">
            <p className="text-base font-medium text-danger">{failure.title}</p>
            <p className="mt-2 text-sm text-fg-secondary">{failure.hint}</p>
            {status.failure.message ? <p className="selectable mt-6 text-sm break-words text-fg-muted">{status.failure.message}</p> : null}
          </div>
        ) : null}
        {!canVerify && needsKey ? <p className="text-sm text-fg-muted">Paste a key to verify it.</p> : null}
      </div>
    </StepLayout>
  );
}
