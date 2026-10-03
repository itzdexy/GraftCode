import { useState } from 'react';
import { Box, CircleCheck, Download, RefreshCw, ShieldAlert } from 'lucide-react';
import { Button } from '../../components/Button';
import { Switch, TextField } from '../../components/Field';
import { LoadingState } from '../../components/States';
import type { SandboxStatus } from '@shared/schemas/system';
import { invoke } from '../../lib/ipc';
import { SANDBOX_IMAGES, setProjectSandbox } from '../../lib/sandbox';
import { useLoad, type Load } from '../../lib/useLoad';
import { useApp } from '../../stores/app';
import { notify, reportError } from '../../stores/toasts';
import { Group, saveSettings, SettingRow, SwitchRow } from './common';

const CUSTOM = 'custom';
const IMAGE = /^[a-z0-9][a-z0-9._/:@-]{0,299}$/i;
const MEMORY_GB = [1, 2, 4, 8, 16, 32];
const CPUS = [1, 2, 4, 8, 16];

function EngineStatus({ refresh, status }: { refresh: () => void; status: Load<SandboxStatus> }) {
  const windows = useApp((s) => s.environment?.platform === 'win32');
  if (status.status === 'loading') return <LoadingState label="Looking for Docker or Podman…" />;
  if (status.status === 'error') {
    return (
      <p role="alert" className="text-sm text-danger">
        {status.message}
      </p>
    );
  }
  const { engine, problem } = status.data;
  return (
    <div className="flex items-start gap-10 rounded-lg border border-border-card bg-raised px-14 py-10">
      {engine ? (
        <CircleCheck className="mt-2 size-16 shrink-0 text-accent" aria-hidden="true" />
      ) : (
        <ShieldAlert className="mt-2 size-16 shrink-0 text-amber-fg" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        {engine ? (
          <>
            <p className="text-base text-fg">
              {engine.kind === 'docker' ? 'Docker' : 'Podman'} {engine.version} is running
            </p>
            <p className="mt-2 text-sm text-fg-muted">
              {engine.cpus} CPUs available{engine.rootless ? ', rootless' : ''}. Sandboxed projects run their commands in it.
            </p>
          </>
        ) : (
          <>
            <p className="text-base text-fg">{problem}</p>
            <p className="mt-2 text-sm text-fg-muted">
              Get{' '}
              <button type="button" className="text-link hover:underline" onClick={() => void invoke('app:openExternal', { url: 'https://www.docker.com/products/docker-desktop/' })}>
                Docker Desktop
              </button>{' '}
              or{' '}
              <button type="button" className="text-link hover:underline" onClick={() => void invoke('app:openExternal', { url: 'https://podman.io/' })}>
                Podman
              </button>
              {windows ? '. Both run Linux containers in a small virtual machine through WSL.' : '.'}
            </p>
          </>
        )}
      </div>
      <Button size="sm" variant="ghost" leading={<RefreshCw className="size-14" />} onClick={refresh}>
        Check again
      </Button>
    </div>
  );
}

/** Any image by name. Keyed by the saved image, so saving one starts the field from it again. */
function CustomImage({ image }: { image: string }) {
  const [text, setText] = useState(image);
  const name = text.trim();
  const error = name !== '' && !IMAGE.test(name) ? 'Use an image name like node:22-bookworm or ghcr.io/owner/image:tag.' : null;
  return (
    <form
      className="flex items-start gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error && name) saveSettings({ sandbox: { image: name } });
      }}
    >
      <TextField
        aria-label="Image name"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="ghcr.io/owner/image:tag"
        inputClassName="font-mono"
        spellCheck={false}
        error={error}
        className="flex-1"
      />
      <Button type="submit" size="sm" variant="secondary" disabled={Boolean(error) || name === image || !name}>
        Use image
      </Button>
    </form>
  );
}

function useStatus() {
  const [tick, setTick] = useState(0);
  const { load, reload } = useLoad(() => invoke('sandbox:status', { refresh: tick > 0 }), String(tick));
  return { load, refresh: () => setTick((n) => n + 1), reload };
}

/** Settings → Sandbox: the container sandboxed projects run their commands in. */
export function SandboxSection() {
  const settings = useApp((s) => s.settings);
  const projects = useApp((s) => s.projects);
  const { load: status, refresh, reload } = useStatus();
  const [custom, setCustom] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [freeing, setFreeing] = useState(false);
  const image = settings?.sandbox.image ?? '';
  const preset = SANDBOX_IMAGES.some((p) => p.image === image) && !custom ? image : CUSTOM;

  if (!settings) return null;
  const ready = status.status === 'ready' && status.data.engine !== null;
  const imageReady = status.status === 'ready' ? status.data.imageReady : null;

  const pull = async (): Promise<void> => {
    setPulling(true);
    try {
      await invoke('sandbox:pull');
      notify('Image downloaded', `${image} is ready for sandboxed sessions.`);
      reload();
    } catch (e) {
      reportError(`Couldn't download ${image}`, e);
    } finally {
      setPulling(false);
    }
  };

  const freeSpace = async (): Promise<void> => {
    setFreeing(true);
    try {
      const { removed } = await invoke('sandbox:freeSpace');
      notify(removed === 0 ? 'Nothing to remove' : `Removed ${removed} cached ${removed === 1 ? 'folder' : 'folders'}`, 'Sandboxes in use keep theirs.');
    } catch (e) {
      reportError("Couldn't free up space", e);
    } finally {
      setFreeing(false);
    }
  };

  return (
    <div className="flex flex-col gap-24">
      <p className="text-sm text-fg-muted">
        A sandboxed project runs the agent’s commands, its checks and your “!” commands in a Linux container instead of on this computer. Only the project folder is
        shared with it, and its .git and .graft folders are read-only there. Your other files, keys, SSH credentials and environment variables are out of reach. In
        Auto-edit and Auto, sandboxed commands run without asking; dangerous ones still ask.
      </p>

      <EngineStatus refresh={refresh} status={status} />

      <Group title="Projects" description="Turn the sandbox on for the projects whose code you want kept away from this computer. It applies from the next message.">
        {projects.length === 0 ? <p className="px-14 py-10 text-sm text-fg-muted">Open a project folder in a code session first.</p> : null}
        {projects.map((p) => (
          <SettingRow
            key={p.id}
            label={p.name}
            description={<span className="font-mono text-xs">{p.path}</span>}
            control={
              <Switch
                label={`Sandbox for ${p.name}`}
                checked={p.settings.sandbox === true}
                disabled={!ready && p.settings.sandbox !== true}
                onChange={(on) => setProjectSandbox(p, on).catch((e: unknown) => reportError("Couldn't change the sandbox", e))}
              />
            }
          />
        ))}
      </Group>

      <Group title="Container">
        <SettingRow
          label="Image"
          description="The system the commands run in. Pick one with the tools your projects need; anything else can be installed from inside."
          control={
            <select
              aria-label="Sandbox image"
              className="h-28 rounded-md border border-input-border bg-input px-8 text-base text-fg outline-none focus:border-border-strong"
              value={preset}
              onChange={(e) => {
                if (e.target.value === CUSTOM) {
                  setCustom(true);
                  return;
                }
                setCustom(false);
                saveSettings({ sandbox: { image: e.target.value } });
              }}
            >
              {SANDBOX_IMAGES.map((p) => (
                <option key={p.image} value={p.image}>
                  {p.label}
                </option>
              ))}
              <option value={CUSTOM}>Another image…</option>
            </select>
          }
        >
          {preset === CUSTOM ? <CustomImage key={image} image={image} /> : null}
          <div className="flex items-center gap-8 text-sm text-fg-muted">
            <Box className="size-14 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-mono">{image}</span>
            {imageReady === true ? <span>Downloaded</span> : null}
            {imageReady === false ? (
              <Button size="sm" variant="secondary" leading={<Download className="size-14" />} disabled={pulling} onClick={() => void pull()}>
                {pulling ? 'Downloading…' : 'Download now'}
              </Button>
            ) : null}
          </div>
        </SettingRow>
        <SwitchRow
          label="Internet access"
          description="Lets installs and downloads work, and forwards common dev-server ports to this computer. Turn it off for code you don’t trust: the container then has no network at all."
          checked={settings.sandbox.network}
          onChange={(on) => saveSettings({ sandbox: { network: on } })}
        />
        <SettingRow
          label="Memory"
          description="The most the container may use."
          control={
            <select
              aria-label="Sandbox memory"
              className="h-28 rounded-md border border-input-border bg-input px-8 text-base text-fg outline-none focus:border-border-strong"
              value={String(Math.round(settings.sandbox.memoryMb / 1024))}
              onChange={(e) => saveSettings({ sandbox: { memoryMb: Number(e.target.value) * 1024 } })}
            >
              {MEMORY_GB.map((gb) => (
                <option key={gb} value={String(gb)}>
                  {gb} GB
                </option>
              ))}
            </select>
          }
        />
        <SettingRow
          label="CPUs"
          description="How many processor cores it may use at once."
          control={
            <select
              aria-label="Sandbox CPUs"
              className="h-28 rounded-md border border-input-border bg-input px-8 text-base text-fg outline-none focus:border-border-strong"
              value={String(settings.sandbox.cpus)}
              onChange={(e) => saveSettings({ sandbox: { cpus: Number(e.target.value) } })}
            >
              {CPUS.map((n) => (
                <option key={n} value={String(n)}>
                  {n}
                </option>
              ))}
            </select>
          }
        />
      </Group>

      <Group title="Storage">
        <SettingRow
          label="Cached dependencies"
          description="Each sandboxed project keeps its node_modules in a volume, so reinstalling is quick. Removing them frees disk space; they come back with the next install."
          control={
            <Button size="sm" variant="secondary" disabled={!ready || freeing} onClick={() => void freeSpace()}>
              {freeing ? 'Removing…' : 'Free up space'}
            </Button>
          }
        />
      </Group>
    </div>
  );
}
