import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Camera,
  ChevronDown,
  ChevronUp,
  EllipsisVertical,
  Eraser,
  ExternalLink,
  Globe,
  Lock,
  Monitor,
  MonitorSmartphone,
  MousePointerClick,
  RefreshCw,
  RotateCw,
  ScanSearch,
  Search,
  Send,
  Smartphone,
  SquareTerminal,
  Tablet,
  Trash2,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import { lookedAt, notListed } from '@shared/pageCheck';
import type { BrowserCommand, ConsoleEntryView, PageCheck, PickedElementView } from '@shared/schemas/panels';
import { Button, IconButton } from '../../components/Button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/Menu';
import { cn } from '../../lib/cn';
import { errorText, invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { usePanels } from '../../stores/panels';
import { notify, reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { checkHeadline, fixPageRequest, problemsFound } from './pageCheckModel';
import { PanelFrame } from './PanelFrame';
import { withRequest } from './problemsModel';

const QUICK = ['localhost:3000', 'localhost:5173', 'localhost:8080'];

type Device = 'desktop' | 'tablet' | 'phone';
const DEVICES: Array<{ id: Device; label: string; width: number | null; icon: typeof Monitor }> = [
  { id: 'desktop', label: 'Full width', width: null, icon: Monitor },
  { id: 'tablet', label: 'Tablet (768 px)', width: 768, icon: Tablet },
  { id: 'phone', label: 'Phone (390 px)', width: 390, icon: Smartphone }
];

/** Menus, popovers and dialogs that the native page view would otherwise cover (tooltips don't count). */
function blockingOverlayOpen(): boolean {
  if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return true;
  return [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].some((el) => !el.querySelector('[role="tooltip"]'));
}

function command(name: BrowserCommand): void {
  invoke('browser:command', { command: name }).catch((error: unknown) => reportError("The browser didn't respond", error));
}

function isSecure(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

function consoleText(entries: ConsoleEntryView[]): string {
  return entries.map((e) => `[${e.level}] ${e.message}${e.source ? ` (${e.source}:${e.line})` : ''}`).join('\n');
}

function elementText(el: PickedElementView): string {
  const styles = Object.entries(el.styles)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
  return [
    'Element picked in the Browser panel',
    `Page: ${el.url}`,
    `Selector: ${el.selector}`,
    `Size: ${el.size.width}×${el.size.height}`,
    `Styles: ${styles}`,
    el.text ? `Text: ${el.text}` : null,
    '',
    el.html
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

/** Dev servers running now, on this computer and in the session's sandbox. */
function useServers(sessionId: string, active: boolean): Array<{ url: string; label: string }> {
  const [servers, setServers] = useState<Array<{ url: string; label: string }>>([]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const scan = (): void => {
      Promise.all([invoke('browser:servers'), invoke('sandbox:ports', { sessionId }).catch(() => [])])
        .then(([local, boxed]) => {
          if (cancelled) return;
          setServers([
            ...boxed.map((p) => ({ url: `http://127.0.0.1:${p.hostPort}`, label: `sandbox :${p.port}` })),
            ...local.map((s) => ({ url: s.url, label: `localhost:${s.port}` }))
          ]);
        })
        .catch((error: unknown) => logError('Could not look for dev servers', error));
    };
    scan();
    const timer = setInterval(scan, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, active]);
  return servers;
}

function FindBar({ onClose }: { onClose: () => void }) {
  const find = usePanels((s) => s.browser?.find ?? null);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const search = (forward: boolean, next: boolean): void => {
    invoke('browser:find', { text, forward, next }).catch((error: unknown) => logError('Find in page failed', error));
  };
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        search(true, true);
      }}
      className="flex h-32 shrink-0 items-center gap-4 border-b border-border-panel px-6"
    >
      <Search className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          invoke('browser:find', { text: e.target.value, forward: true, next: false }).catch((error: unknown) => logError('Find in page failed', error));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault();
            search(false, true);
          }
        }}
        aria-label="Find in page"
        placeholder="Find in page"
        className="h-24 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-faint"
      />
      <span className="shrink-0 text-xs text-fg-faint tabular-nums">{find && text ? `${find.matches === 0 ? 0 : find.active}/${find.matches}` : ''}</span>
      <IconButton label="Previous match" size="xs" disabled={!text} onClick={() => search(false, true)}>
        <ChevronUp className="size-14" />
      </IconButton>
      <IconButton label="Next match" size="xs" disabled={!text} onClick={() => search(true, true)}>
        <ChevronDown className="size-14" />
      </IconButton>
      <IconButton label="Close find" size="xs" onClick={onClose}>
        <X className="size-14" />
      </IconButton>
    </form>
  );
}

function ConsoleDrawer({ onClose, onSend }: { onClose: () => void; onSend: (entries: ConsoleEntryView[]) => void }) {
  const problems = usePanels((s) => s.browser?.problems ?? 0);
  const url = usePanels((s) => s.browser?.url ?? '');
  const [entries, setEntries] = useState<ConsoleEntryView[]>([]);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);

  // Reloads when the page logs a problem or changes; quiet logs show up on the next problem or reopen.
  useEffect(() => {
    let cancelled = false;
    invoke('browser:console')
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((error: unknown) => logError('Could not read the console', error));
    return () => {
      cancelled = true;
    };
  }, [problems, url]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const shown = onlyProblems ? entries.filter((e) => e.level === 'error' || e.level === 'warning') : entries;
  return (
    <section aria-label="Console" className="flex h-[38%] min-h-[120px] shrink-0 flex-col border-t border-border-panel">
      <header className="flex h-28 shrink-0 items-center gap-6 border-b border-border-subtle pr-4 pl-10">
        <SquareTerminal className="size-14 text-icon-muted" aria-hidden="true" />
        <span className="text-sm text-fg-secondary">Console</span>
        <button
          type="button"
          aria-pressed={onlyProblems}
          onClick={() => setOnlyProblems(!onlyProblems)}
          className={cn('rounded-sm px-6 text-xs transition-ui', onlyProblems ? 'bg-control text-fg' : 'text-fg-muted hover:text-fg-secondary')}
        >
          Errors and warnings
        </button>
        <span className="flex-1" />
        <IconButton label="Send to chat" size="xs" disabled={shown.length === 0} onClick={() => onSend(shown)}>
          <Send className="size-14" />
        </IconButton>
        <IconButton
          label="Clear console"
          size="xs"
          onClick={() => {
            command('clearConsole');
            setEntries([]);
          }}
        >
          <Trash2 className="size-14" />
        </IconButton>
        <IconButton label="Close console" size="xs" onClick={onClose}>
          <X className="size-14" />
        </IconButton>
      </header>
      <ol ref={listRef} className="selectable min-h-0 flex-1 overflow-auto py-2 font-mono text-[calc(var(--g-code-font-size)-2px)] leading-[1.5]">
        {shown.length === 0 ? <li className="px-10 py-6 font-sans text-sm text-fg-faint">{onlyProblems ? 'No errors or warnings.' : 'Nothing logged yet.'}</li> : null}
        {shown.map((e, i) => (
          <li
            key={`${e.at}:${i}`}
            className={cn(
              'border-b border-border-subtle px-10 py-2 break-words whitespace-pre-wrap',
              e.level === 'error' ? 'bg-danger-bg text-danger' : e.level === 'warning' ? 'bg-warning-bg text-warning-fg' : 'text-fg-secondary'
            )}
          >
            {e.message}
            {e.source ? <span className="ml-8 text-fg-faint">{e.source.split('/').pop()}:{e.line}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

type CheckLoad = { state: 'checking' } | { state: 'error'; message: string } | { state: 'done'; check: PageCheck };

/**
 * What the page check found, under the page: the problems first, each with
 * where it is. Pressing a finding brings what it is about into view in the
 * page and draws a box around it. The list is of the page as it was laid out
 * when it was checked: the headline says how wide that was.
 */
function PageCheckDrawer({ load, onAgain, onAsk, onClose }: { load: CheckLoad; onAgain: () => void; onAsk: (check: PageCheck) => void; onClose: () => void }) {
  const check = load.state === 'done' ? load.check : null;
  const show = (selector: string): void => {
    invoke('browser:highlight', { selector })
      .then((found) => {
        if (!found) notify('That is no longer in the page', 'Check again to see the page as it is now.');
      })
      .catch((error: unknown) => reportError("Couldn't show it in the page", error));
  };
  return (
    <section aria-label="Page check" className="flex h-[38%] min-h-[120px] shrink-0 flex-col border-t border-border-panel">
      <header className="flex h-28 shrink-0 items-center gap-6 border-b border-border-subtle pr-4 pl-10">
        <ScanSearch className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />
        <span role="status" className="min-w-0 flex-1 truncate text-sm text-fg-secondary">
          {load.state === 'checking' ? 'Checking the page…' : check ? checkHeadline(check) : 'The page could not be checked'}
        </span>
        <IconButton label="Check again" size="xs" disabled={load.state === 'checking'} onClick={onAgain}>
          <RefreshCw className="size-12" />
        </IconButton>
        <IconButton label="Close page check" size="xs" onClick={onClose}>
          <X className="size-14" />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-auto py-2">
        {load.state === 'error' ? (
          <p role="alert" className="selectable px-10 py-6 text-sm text-danger">
            {load.message}
          </p>
        ) : null}
        {check ? (
          <>
            <ul>
              {check.findings.map((finding, i) => {
                const kind = finding.severity === 'error' ? 'Problem' : 'Warning';
                const body = (
                  <>
                    <span role="img" aria-label={kind} className={cn('mt-[5px] size-6 shrink-0 rounded-full', finding.severity === 'error' ? 'bg-danger' : 'bg-amber')} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm break-words text-fg">{finding.message}</span>
                      {finding.selector ? (
                        <span className="block truncate font-mono text-2xs text-fg-faint">
                          {finding.selector}
                          {finding.label ? ` · ${finding.label}` : ''}
                        </span>
                      ) : null}
                    </span>
                  </>
                );
                return (
                  <li key={i}>
                    {finding.selector ? (
                      <button
                        type="button"
                        aria-label={`${kind}: ${finding.message} At ${finding.selector}`}
                        title="Show it in the page"
                        onClick={() => show(finding.selector)}
                        className="flex w-full items-start gap-8 px-10 py-4 text-left transition-ui hover:bg-hover focus-visible:bg-hover"
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="flex items-start gap-8 px-10 py-4">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="selectable px-10 py-6 text-xs text-fg-faint">{[notListed(check), lookedAt(check)].filter((part) => part !== null).join(' ')}</p>
          </>
        ) : null}
      </div>
      {check && check.findings.length > 0 ? (
        <div className="flex shrink-0 items-center justify-end border-t border-border-subtle p-6">
          <Button size="sm" variant="secondary" onClick={() => onAsk(check)} title="Writes the request into the message box. Nothing is sent until you send it.">
            Ask Graft to fix these
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Browser panel for local dev servers and docs. The page itself is a native
 * view main positions over the area below the toolbar; it is hidden while
 * menus or dialogs are open so they stay on top. Screenshots, picked elements
 * and console logs go to this session's message box, and so does the request
 * to fix what the page check found.
 */
export function BrowserPanelView({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const state = usePanels((s) => s.browser);
  const [address, setAddress] = useState(state?.url ?? '');
  const [editing, setEditing] = useState(false);
  const [device, setDevice] = useState<Device>('desktop');
  const [finding, setFinding] = useState(false);
  /** The console and the page check share the space under the page: one at a time. */
  const [drawer, setDrawer] = useState<'console' | 'check' | null>(null);
  /** The last check, with the page it was of: a check of another page is not this page's. */
  const [checked, setChecked] = useState<{ url: string; load: CheckLoad } | null>(null);
  const checkAsked = useRef(0);
  const [sizing, setSizing] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const hasPage = Boolean(state?.url);
  const shownAddress = editing ? address : (state?.url ?? address);
  const servers = useServers(sessionId, !hasPage);
  const width = DEVICES.find((d) => d.id === device)?.width ?? null;

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !hasPage) return;
    let frame = 0;
    const send = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const visible = r.width > 0 && r.height > 0 && !blockingOverlayOpen();
        invoke('browser:bounds', { bounds: visible ? { x: r.left, y: r.top, width: r.width, height: r.height } : null }).catch((error: unknown) =>
          logError('Could not position the browser view', error)
        );
      });
    };
    const resize = new ResizeObserver(send);
    resize.observe(el);
    const overlays = new MutationObserver(send);
    overlays.observe(document.body, { childList: true });
    window.addEventListener('resize', send);
    // The column this panel is in slides open and shut. The page is a native view, which can't be clipped with the
    // column, so it steps out while the column moves and is put back where the panel then is once it is still.
    const onSlide = (event: TransitionEvent): void => {
      if (event.propertyName !== 'grid-template-columns' || !(event.target instanceof Node) || !event.target.contains(el)) return;
      if (event.type !== 'transitionrun') return send();
      cancelAnimationFrame(frame);
      invoke('browser:bounds', { bounds: null }).catch((error: unknown) => logError('Could not hide the browser view', error));
    };
    const slides = ['transitionrun', 'transitionend', 'transitioncancel'] as const;
    for (const slide of slides) document.addEventListener(slide, onSlide);
    send();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      overlays.disconnect();
      window.removeEventListener('resize', send);
      for (const slide of slides) document.removeEventListener(slide, onSlide);
      invoke('browser:bounds', { bounds: null }).catch((error: unknown) => logError('Could not hide the browser view', error));
    };
  }, [hasPage]);

  // Keys the page passed on: Ctrl+F opens find, Ctrl+L the address bar.
  useEffect(
    () =>
      usePanels.subscribe((s, prev) => {
        const key = s.browserShortcut;
        if (!key || key.seq === prev.browserShortcut?.seq) return;
        if (key.name === 'find') setFinding(true);
        else addressRef.current?.select();
      }),
    []
  );

  const go = (target: string): void => {
    setEditing(false);
    invoke('browser:navigate', { url: target })
      .then((r) => setAddress(r.url))
      .catch((error: unknown) => reportError("Couldn't open that address", error));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (address.trim()) go(address);
  };

  const send = useCallback(
    (add: Parameters<ReturnType<typeof useUi.getState>['sendToComposer']>[1], what: string) => {
      useUi.getState().sendToComposer(sessionId, add);
      notify(`${what} added to your message`);
    },
    [sessionId]
  );

  const screenshot = (): void => {
    invoke('browser:capture')
      .then((image) => send({ images: [image] }, 'Screenshot'))
      .catch((error: unknown) => reportError("Couldn't take a screenshot", error));
  };

  const pageUrl = state?.url ?? '';
  const pageLoading = state?.loading ?? false;
  const runCheck = useCallback((): void => {
    const url = usePanels.getState().browser?.url ?? '';
    const asked = ++checkAsked.current;
    setChecked({ url, load: { state: 'checking' } });
    invoke('browser:check').then(
      (check) => {
        if (asked === checkAsked.current) setChecked({ url, load: { state: 'done', check } });
      },
      (error: unknown) => {
        if (asked === checkAsked.current) setChecked({ url, load: { state: 'error', message: errorText(error) } });
      }
    );
  }, []);
  // The drawer shows the page as it is: it checks when it opens, and again when the page or its width changes.
  useEffect(() => {
    if (drawer !== 'check' || pageUrl === '' || pageLoading) return;
    // A moment for the page to take a new width before it is measured.
    const timer = setTimeout(runCheck, 200);
    return () => clearTimeout(timer);
  }, [drawer, pageUrl, pageLoading, device, runCheck]);
  const checkLoad: CheckLoad = checked && checked.url === pageUrl ? checked.load : { state: 'checking' };
  const problems = problemsFound(checked && checked.url === pageUrl && checked.load.state === 'done' ? checked.load.check : null);

  const askForFix = (check: PageCheck): void => {
    const ui = useUi.getState();
    ui.setDraft(sessionId, withRequest(ui.drafts[sessionId] ?? '', fixPageRequest(check)));
    ui.focusComposer?.();
  };

  const screenshotSizes = (): void => {
    setSizing(true);
    invoke('browser:captureSizes')
      .then((shots) => send({ images: shots.map((shot) => shot.image) }, 'Phone, tablet and desktop screenshots'))
      .catch((error: unknown) => reportError("Couldn't take the screenshots", error))
      .finally(() => setSizing(false));
  };

  const pick = (): void => {
    if (state?.picking) {
      command('cancelPick');
      return;
    }
    invoke('browser:pick')
      .then((el) => {
        // Its picture goes along for a model that can read one; the element itself is the text.
        if (el) send({ files: [{ name: 'picked-element.txt', content: elementText(el) }], extras: el.image ? [el.image] : [] }, 'The element');
      })
      .catch((error: unknown) => reportError("Couldn't pick an element", error));
  };

  return (
    <PanelFrame
      label="Browser"
      // The page is a native view laid over this panel where it was measured: the panel must not travel into place.
      className="graft-panel--still"
      onClose={() => {
        command('close');
        onClose();
      }}
      title={
        <span className="flex min-w-0 items-center gap-6">
          <Globe className="size-14 shrink-0 text-icon" aria-hidden="true" />
          <span className="truncate">{state?.title || 'Browser'}</span>
        </span>
      }
      actions={
        hasPage ? (
          <IconButton label="Open in your browser" size="xs" onClick={() => command('external')}>
            <ExternalLink className="size-14" />
          </IconButton>
        ) : null
      }
    >
      <form onSubmit={submit} className="flex h-32 shrink-0 items-center gap-2 border-b border-border-panel px-4">
        <IconButton label="Back" size="xs" disabled={!state?.canGoBack} onClick={() => command('back')}>
          <ArrowLeft className="size-14" />
        </IconButton>
        <IconButton label="Forward" size="xs" disabled={!state?.canGoForward} onClick={() => command('forward')}>
          <ArrowRight className="size-14" />
        </IconButton>
        <IconButton label={state?.loading ? 'Stop' : 'Reload'} size="xs" disabled={!hasPage} onClick={() => command(state?.loading ? 'stop' : 'reload')}>
          {state?.loading ? <X className="size-14" /> : <RotateCw className="size-14" />}
        </IconButton>
        <div className="relative flex min-w-0 flex-1 items-center">
          {hasPage && !editing ? (
            isSecure(state?.url ?? '') ? (
              <Lock className="pointer-events-none absolute left-6 size-12 text-icon-muted" aria-label="Secure or local" role="img" />
            ) : (
              <Globe className="pointer-events-none absolute left-6 size-12 text-amber-fg" aria-label="Not secure" role="img" />
            )
          ) : null}
          <input
            ref={addressRef}
            value={shownAddress}
            onChange={(e) => {
              setEditing(true);
              setAddress(e.target.value);
            }}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditing(false);
                e.currentTarget.blur();
              }
            }}
            aria-label="Address"
            placeholder="localhost:3000 or https://…"
            spellCheck={false}
            className={cn(
              'h-24 w-full min-w-0 rounded-sm border border-input-border bg-input pr-8 font-mono text-sm text-fg outline-none focus:border-border-strong',
              hasPage && !editing ? 'pl-22' : 'pl-8'
            )}
          />
        </div>
      </form>
      {state?.loading ? <div className="graft-loadbar h-2 shrink-0" role="progressbar" aria-label="Loading" /> : null}
      {hasPage ? (
        <div className="flex min-h-28 shrink-0 flex-wrap items-center gap-2 border-b border-border-panel px-4 py-3" role="toolbar" aria-label="Page tools">
          {DEVICES.map((d) => (
            <IconButton key={d.id} label={d.label} size="xs" aria-pressed={device === d.id} active={device === d.id} onClick={() => setDevice(d.id)}>
              <d.icon className="size-14" />
            </IconButton>
          ))}
          <span className="mx-4 h-14 w-px bg-border-subtle" aria-hidden="true" />
          <IconButton label="Zoom out" size="xs" onClick={() => command('zoomOut')}>
            <ZoomOut className="size-14" />
          </IconButton>
          <button type="button" onClick={() => command('zoomReset')} className="h-20 min-w-[40px] rounded-sm px-2 text-xs text-fg-muted tabular-nums hover:bg-hover" title="Reset zoom">
            {Math.round((state?.zoom ?? 1) * 100)}%
          </button>
          <IconButton label="Zoom in" size="xs" onClick={() => command('zoomIn')}>
            <ZoomIn className="size-14" />
          </IconButton>
          <span className="flex-1" />
          <IconButton
            label={state?.picking ? 'Cancel picking (Esc)' : 'Pick an element for the chat'}
            size="xs"
            aria-pressed={state?.picking ?? false}
            active={state?.picking ?? false}
            className={cn(state?.picking && 'text-accent')}
            onClick={pick}
          >
            <MousePointerClick className="size-14" />
          </IconButton>
          <IconButton label="Screenshot to chat" size="xs" onClick={screenshot}>
            <Camera className="size-14" />
          </IconButton>
          <IconButton label="Screenshot at phone, tablet and desktop size" size="xs" disabled={sizing} aria-busy={sizing} onClick={screenshotSizes}>
            <MonitorSmartphone className="size-14" />
          </IconButton>
          <span className="relative">
            <IconButton label="Check the page" size="xs" aria-pressed={drawer === 'check'} active={drawer === 'check'} onClick={() => setDrawer(drawer === 'check' ? null : 'check')}>
              <ScanSearch className="size-14" />
            </IconButton>
            {problems > 0 ? (
              <span className="pointer-events-none absolute -top-2 -right-2 min-w-[14px] rounded-full bg-danger px-3 text-center text-[10px] leading-[14px] font-medium text-white tabular-nums">
                {Math.min(99, problems)}
              </span>
            ) : null}
          </span>
          <span className="relative">
            <IconButton label="Console" size="xs" aria-pressed={drawer === 'console'} active={drawer === 'console'} onClick={() => setDrawer(drawer === 'console' ? null : 'console')}>
              <SquareTerminal className="size-14" />
            </IconButton>
            {(state?.problems ?? 0) > 0 ? (
              <span className="pointer-events-none absolute -top-2 -right-2 min-w-[14px] rounded-full bg-danger px-3 text-center text-[10px] leading-[14px] font-medium text-white tabular-nums">
                {Math.min(99, state?.problems ?? 0)}
              </span>
            ) : null}
          </span>
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="More page tools" size="xs">
                <EllipsisVertical className="size-14" />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end" className="min-w-[220px]">
              <MenuItem icon={<Search className="size-14" />} shortcut="Ctrl+F" onSelect={() => setFinding(true)}>
                Find in page
              </MenuItem>
              <MenuItem icon={<RotateCw className="size-14" />} shortcut="Ctrl+Shift+R" onSelect={() => command('hardReload')}>
                Reload without cache
              </MenuItem>
              <MenuItem icon={<Bug className="size-14" />} shortcut="F12" onSelect={() => command('devtools')}>
                {state?.devtools ? 'Close developer tools' : 'Developer tools'}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Eraser className="size-14" />} onSelect={() => command('clearData')}>
                Clear cookies and site data
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      ) : null}
      {finding && hasPage ? (
        <FindBar
          onClose={() => {
            setFinding(false);
            command('stopFind');
          }}
        />
      ) : null}
      {state?.error ? (
        <p role="alert" className="selectable shrink-0 border-b border-border-panel bg-danger-bg px-10 py-4 text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state?.picking ? <p className="shrink-0 border-b border-border-panel bg-accent/10 px-10 py-4 text-sm text-fg-secondary">Click an element in the page to add it to your message. Esc cancels.</p> : null}
      {hasPage ? (
        <div className="flex min-h-0 flex-1 justify-center overflow-hidden bg-surface">
          <div
            ref={hostRef}
            data-browser-host=""
            className={cn('h-full min-w-0', width ? 'border-x border-border-subtle' : 'w-full')}
            style={width ? { width: `min(100%, ${width}px)` } : undefined}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-10 px-16 text-center">
          <p className="text-base text-fg-secondary">Preview a local dev server or any web page.</p>
          <p className="text-sm text-fg-muted">Pages run isolated from Graft: no access to your files, keys or other sessions.</p>
          {servers.length > 0 ? (
            <div className="mt-4 flex flex-col items-center gap-6">
              <p className="text-xs font-medium tracking-wide text-fg-faint uppercase">Running now</p>
              <div className="flex flex-wrap justify-center gap-6">
                {servers.map((s) => (
                  <button
                    key={s.url}
                    type="button"
                    onClick={() => go(s.url)}
                    className="inline-flex h-24 items-center gap-6 rounded-sm border border-accent/40 px-8 font-mono text-sm text-fg-secondary hover:bg-hover"
                  >
                    <span className="size-6 rounded-full bg-accent" aria-hidden="true" />
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap justify-center gap-6">
            {QUICK.filter((q) => !servers.some((s) => s.label === q)).map((q) => (
              <button key={q} type="button" onClick={() => go(q)} className="h-24 rounded-sm border border-border px-8 font-mono text-sm text-fg-secondary hover:bg-hover">
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
      {drawer === 'check' && hasPage ? <PageCheckDrawer load={checkLoad} onAgain={runCheck} onAsk={askForFix} onClose={() => setDrawer(null)} /> : null}
      {drawer === 'console' && hasPage ? (
        <ConsoleDrawer
          onClose={() => setDrawer(null)}
          onSend={(entries) => send({ files: [{ name: 'console.txt', content: `Console of ${state?.url ?? 'the page'}\n\n${consoleText(entries)}` }] }, 'The console')}
        />
      ) : null}
    </PanelFrame>
  );
}
