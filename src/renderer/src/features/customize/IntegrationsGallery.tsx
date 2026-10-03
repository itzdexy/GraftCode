import { useState, type ComponentType } from 'react';
import { BookOpen, Box, Bug, Gamepad2, ExternalLink, GitPullRequest, Joystick, ListTodo, MonitorPlay, NotebookText, PenTool, Shapes, TriangleAlert } from 'lucide-react';
import { INTEGRATION_CATEGORIES, INTEGRATIONS, RUNTIME_HELP, type Integration } from '@shared/integrations';
import type { ChannelOutput } from '@shared/ipc/contracts';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';
import { Dialog, DialogContent } from '../../components/Dialog';
import { TextField } from '../../components/Field';
import { cn } from '../../lib/cn';
import { errorText, invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { reportError, useToasts } from '../../stores/toasts';

type Blocker = ChannelOutput<'integrations:status'>[number]['blocker'];
type Platform = 'win32' | 'darwin' | 'linux';

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  blender: Shapes,
  'roblox-studio': Gamepad2,
  unity: Box,
  godot: Joystick,
  figma: PenTool,
  playwright: MonitorPlay,
  github: GitPullRequest,
  context7: BookOpen,
  sentry: Bug,
  linear: ListTodo,
  notion: NotebookText
};

const PLATFORM_NAME: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

function copy(text: string): void {
  navigator.clipboard.writeText(text).then(
    () => useToasts.getState().push({ tone: 'success', title: 'Copied' }),
    (error: unknown) => reportError("Couldn't copy to the clipboard", error)
  );
}

/** A setup step, with `code` spans that copy themselves when clicked. */
function Step({ text }: { text: string }) {
  return (
    <>
      {text.split(/`([^`]+)`/).map((part, i) =>
        i % 2 === 1 ? (
          <button
            key={i}
            type="button"
            title="Copy"
            onClick={() => copy(part)}
            className="mx-1 rounded-sm border border-code-border bg-code-bg px-4 font-mono text-sm break-all text-fg transition-ui hover:border-border-strong"
          >
            {part}
          </button>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function BlockerNote({ blocker, integration }: { blocker: Blocker; integration: Integration }) {
  if (!blocker || blocker.kind === 'platform') return null;
  const platform = (window.graft.platform in PLATFORM_NAME ? window.graft.platform : 'linux') as Platform;
  const text =
    blocker.kind === 'runtime' ? (
      <>
        {integration.name} runs with {RUNTIME_HELP[blocker.runtime].name}, which Graft couldn’t find. Install it, then add the integration:{' '}
        <Step text={`\`${RUNTIME_HELP[blocker.runtime].install[platform]}\``} />
      </>
    ) : (
      <>
        Graft couldn’t find <span className="font-mono break-all">{blocker.path}</span>. Install {integration.name} and turn on its MCP server first; you can add it now anyway.
      </>
    );
  return (
    <div className="flex items-start gap-8 rounded-md border border-border bg-warning-bg px-10 py-8 text-sm text-warning-fg">
      <TriangleAlert className="mt-1 size-14 shrink-0" aria-hidden="true" />
      <p className="min-w-0">{text}</p>
    </div>
  );
}

function IntegrationDialog({ integration, blocker, added, onDone }: { integration: Integration; blocker: Blocker; added: boolean; onDone: (added: boolean) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = integration.fields ?? [];
  const incomplete = fields.some((f) => !f.optional && !(values[f.key] ?? '').trim());

  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await invoke('integrations:add', { id: integration.id, values });
      useToasts.getState().push({
        tone: 'success',
        title: `${integration.name} added`,
        description: integration.signIn ? 'Click Sign in next to it to connect your account.' : 'Its tools are ready in code sessions.'
      });
      onDone(true);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <DialogContent
      title={`Add ${integration.name}`}
      description={integration.description}
      className="w-[min(620px,calc(100vw-48px))]"
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto"
            leading={<ExternalLink className="size-14" />}
            onClick={() => void invoke('app:openExternal', { url: integration.docs }).catch((e: unknown) => reportError("Couldn't open the page", e))}
          >
            Documentation
          </Button>
          <Button variant="ghost" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || incomplete} onClick={() => void add()}>
            {busy ? <Spinner size={12} label="Adding" /> : null}
            {added ? 'Add again' : 'Add'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-14">
        <BlockerNote blocker={blocker} integration={integration} />
        <ol className="flex list-decimal flex-col gap-6 pl-18 text-base text-fg-secondary marker:text-fg-muted">
          {integration.steps.map((step) => (
            <li key={step}>
              <Step text={step} />
            </li>
          ))}
        </ol>
        {fields.map((field) => (
          <TextField
            key={field.key}
            label={field.label}
            type={field.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder={field.placeholder}
            value={values[field.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
            hint={field.secret ? 'Kept encrypted on this computer and never shown again.' : field.help}
          />
        ))}
        <p className="text-sm text-fg-muted">
          Graft adds it for all projects. Code sessions offer its tools to the agent as <span className="font-mono">mcp__{integration.serverName}__…</span>, and tools that
          change things ask first.
        </p>
        {error ? (
          <p role="alert" className="selectable text-base text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </DialogContent>
  );
}

/** One-step integrations above the MCP server list: game engines, design tools, browsers and developer services. */
export function IntegrationsGallery({ installed, onAdded }: { installed: ReadonlySet<string>; onAdded: () => void }) {
  const { load, reload } = useLoad(() => invoke('integrations:status'), 'integrations');
  const [adding, setAdding] = useState<Integration | null>(null);
  const blockers = new Map<string, Blocker>(load.status === 'ready' ? load.data.map((s) => [s.id, s.blocker]) : []);
  const platform = PLATFORM_NAME[window.graft.platform] ?? window.graft.platform;

  return (
    <section aria-label="Integrations" className="flex flex-col gap-12">
      <header>
        <h2 className="text-md font-medium text-fg-strong">Integrations</h2>
        <p className="mt-2 text-sm text-fg-muted">Connect Graft to the apps you build with. Each one runs as an MCP server that code sessions can use.</p>
      </header>
      {INTEGRATION_CATEGORIES.map((category) => (
        <div key={category} className="flex flex-col gap-6">
          <h3 className="text-xs font-medium tracking-wide text-fg-faint uppercase">{category}</h3>
          <ul className="grid grid-cols-3 gap-8">
            {INTEGRATIONS.filter((i) => i.category === category).map((integration) => {
              const Icon = ICONS[integration.id] ?? Box;
              const blocker = blockers.get(integration.id) ?? null;
              const unavailable = blocker?.kind === 'platform';
              const added = installed.has(integration.serverName);
              return (
                <li key={integration.id}>
                  <button
                    type="button"
                    disabled={unavailable}
                    onClick={() => setAdding(integration)}
                    aria-label={`${integration.name}: ${integration.description}`}
                    className={cn(
                      'group flex h-full w-full flex-col gap-4 rounded-lg border border-border-card bg-raised px-12 py-10 text-left transition-ui',
                      unavailable ? 'opacity-55' : 'hover:-translate-y-px hover:border-border-strong hover:bg-hover'
                    )}
                  >
                    <span className="flex items-center gap-8">
                      <Icon className="size-16 shrink-0 text-accent transition-ui group-hover:scale-110" />
                      <span className="min-w-0 flex-1 truncate text-base font-medium text-fg">{integration.name}</span>
                      {added ? <Badge tone="accent">Added</Badge> : unavailable ? <Badge>Not on {platform}</Badge> : null}
                    </span>
                    <span className="line-clamp-2 text-sm text-fg-muted">{integration.description}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <Dialog open={adding !== null} onOpenChange={(open) => (open ? undefined : setAdding(null))}>
        {adding ? (
          <IntegrationDialog
            key={adding.id}
            integration={adding}
            blocker={blockers.get(adding.id) ?? null}
            added={installed.has(adding.serverName)}
            onDone={(added) => {
              setAdding(null);
              if (added) {
                onAdded();
                reload();
              }
            }}
          />
        ) : null}
      </Dialog>
    </section>
  );
}
