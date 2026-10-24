import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import { Eraser, EllipsisVertical, Plus, SquareTerminal, X } from 'lucide-react';
import type { TerminalInfoView } from '@shared/schemas/panels';
import { IconButton } from '../../components/Button';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuSwitchItem, MenuTrigger } from '../../components/Menu';
import { ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { errorText, invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { useApp } from '../../stores/app';
import { panelBus, usePanels } from '../../stores/panels';
import { reportError } from '../../stores/toasts';
import { PanelFrame } from './PanelFrame';
import { CURSOR_STYLES, SCROLLBACK_CHOICES, useTerminalPrefs } from './terminalPrefs';
import { StreamJoiner } from './terminalStream';

const DARK: ITheme = {
  background: '#1a1a19',
  foreground: '#e8e8e5',
  cursor: '#f0efec',
  cursorAccent: '#1a1a19',
  selectionBackground: '#2a78d666',
  black: '#262625',
  red: '#e5604e',
  green: '#7fbf6a',
  yellow: '#e7a314',
  blue: '#689fe0',
  magenta: '#b48ad4',
  cyan: '#4fa3a0',
  white: '#bebdb2',
  brightBlack: '#74736e',
  brightRed: '#f08070',
  brightGreen: '#97d183',
  brightYellow: '#fab219',
  brightBlue: '#8ab6ea',
  brightMagenta: '#c9a6e2',
  brightCyan: '#6cc0bc',
  brightWhite: '#f0efec'
};

const LIGHT: ITheme = {
  background: '#f1f0ec',
  foreground: '#1f1e1d',
  cursor: '#141413',
  cursorAccent: '#f1f0ec',
  selectionBackground: '#1f6fd133',
  black: '#1f1e1d',
  red: '#c4382c',
  green: '#3f8a36',
  yellow: '#8f5f00',
  blue: '#1d63bd',
  magenta: '#8a4fb5',
  cyan: '#1f7f7a',
  white: '#6b6a64',
  brightBlack: '#807f79',
  brightRed: '#cf222e',
  brightGreen: '#2f7128',
  brightYellow: '#8a5700',
  brightBlue: '#1f6fd1',
  brightMagenta: '#9a5cc7',
  brightCyan: '#1a7f7a',
  brightWhite: '#141413'
};

function themeNow(): ITheme {
  return document.documentElement.dataset.theme === 'light' ? LIGHT : DARK;
}

/** One xterm.js view bound to a pty: input goes to main, output streams back. */
function XtermView({ terminal, active, typed, cleared }: { terminal: TerminalInfoView; active: boolean; typed: number; cleared: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const fontSize = useApp((s) => s.settings?.appearance.codeFontSize ?? 13);
  const fontSizeRef = useRef(fontSize);
  const prefs = useTerminalPrefs();
  const prefsRef = useRef(prefs);
  useLayoutEffect(() => {
    fontSizeRef.current = fontSize;
    prefsRef.current = prefs;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--g-font-mono') || 'monospace',
      fontSize: fontSizeRef.current,
      lineHeight: 1.2,
      cursorStyle: prefsRef.current.cursorStyle,
      cursorBlink: prefsRef.current.cursorBlink,
      scrollback: prefsRef.current.scrollback,
      allowProposedApi: false,
      theme: themeNow()
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const joiner = new StreamJoiner((data) => term.write(data));
    const offData = panelBus.onPtyData(terminal.id, (data, offset) => joiner.chunk(data, offset));
    const offExit = panelBus.onPtyExit(terminal.id, (code) => term.write(`\r\n\x1b[2m[Process exited with code ${code}]\x1b[0m\r\n`));
    invoke('pty:snapshot', { id: terminal.id })
      .then((snap) => joiner.snapshot(snap.data, snap.end))
      .catch((error: unknown) => logError('Could not restore terminal output', error));

    const input = term.onData((data) => {
      invoke('pty:write', { id: terminal.id, data }).catch((error: unknown) => logError('Terminal input failed', error));
    });
    // With "Copy on select", what is selected goes to the clipboard as the selection ends.
    const selected = term.onSelectionChange(() => {
      if (!prefsRef.current.copyOnSelect || !term.hasSelection()) return;
      navigator.clipboard.writeText(term.getSelection()).catch((error: unknown) => logError('Could not copy the selection', error));
    });
    const resized = term.onResize(({ cols, rows }) => {
      invoke('pty:resize', { id: terminal.id, cols, rows }).catch((error: unknown) => logError('Terminal resize failed', error));
    });
    const observer = new ResizeObserver(() => {
      if (host.offsetWidth > 0 && host.offsetHeight > 0) fit.fit();
    });
    observer.observe(host);
    const themeObserver = new MutationObserver(() => {
      term.options.theme = themeNow();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      input.dispose();
      selected.dispose();
      resized.dispose();
      offData();
      offExit();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminal.id]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontSize]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.cursorStyle = prefs.cursorStyle;
    term.options.cursorBlink = prefs.cursorBlink;
    term.options.scrollback = prefs.scrollback;
  }, [prefs.cursorStyle, prefs.cursorBlink, prefs.scrollback]);

  // `cleared` counts the Clear requests; the terminal in front clears its screen and what scrolled away.
  useEffect(() => {
    if (cleared > 0 && active) termRef.current?.clear();
  }, [cleared, active]);

  // `typed` counts the lines typed in from outside: after each, the keyboard is here, so Enter runs the line.
  useEffect(() => {
    if (!active) return;
    fitRef.current?.fit();
    termRef.current?.focus();
  }, [active, typed]);

  return <div ref={hostRef} className={cn('min-h-0 flex-1 px-6 py-4', active ? 'block' : 'hidden')} data-testid={`terminal-${terminal.id}`} />;
}

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready' };

/** How the terminals draw and behave: the cursor, copying a selection, how far back they keep, and clearing the one in front. */
function TerminalOptions({ onClear }: { onClear: () => void }) {
  const prefs = useTerminalPrefs();
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton label="Terminal options" size="xs">
          <EllipsisVertical className="size-14" />
        </IconButton>
      </MenuTrigger>
      <MenuContent align="end" className="w-[220px]">
        <MenuSub>
          <MenuSubTrigger>Cursor style</MenuSubTrigger>
          <MenuSubContent className="w-[160px]">
            {CURSOR_STYLES.map((style) => (
              <MenuItem key={style.value} checked={prefs.cursorStyle === style.value} onSelect={() => prefs.set({ cursorStyle: style.value })}>
                {style.label}
              </MenuItem>
            ))}
          </MenuSubContent>
        </MenuSub>
        <MenuSwitchItem checked={prefs.cursorBlink} onCheckedChange={(cursorBlink) => prefs.set({ cursorBlink })}>
          Blink cursor
        </MenuSwitchItem>
        <MenuSwitchItem checked={prefs.copyOnSelect} onCheckedChange={(copyOnSelect) => prefs.set({ copyOnSelect })} description="Selected text goes to the clipboard">
          Copy on select
        </MenuSwitchItem>
        <MenuSub>
          <MenuSubTrigger>Scrollback</MenuSubTrigger>
          <MenuSubContent className="w-[180px]">
            <MenuLabel>Lines kept above the screen</MenuLabel>
            {SCROLLBACK_CHOICES.map((lines) => (
              <MenuItem key={lines} checked={prefs.scrollback === lines} onSelect={() => prefs.set({ scrollback: lines })}>
                {lines.toLocaleString('en-US')}
              </MenuItem>
            ))}
          </MenuSubContent>
        </MenuSub>
        <MenuSeparator />
        <MenuItem icon={<Eraser className="size-14" />} onSelect={onClear}>
          Clear terminal
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** Terminal panel: real pty tabs in the session's folder. */
export function TerminalPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [terminals, setTerminals] = useState<TerminalInfoView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const create = useCallback(async (): Promise<void> => {
    try {
      const info = await invoke('pty:create', { sessionId, cols: 80, rows: 24 });
      setTerminals((list) => [...list, info]);
      setActiveId(info.id);
      setLoad({ state: 'ready' });
    } catch (error) {
      setLoad({ state: 'error', message: errorText(error) });
    }
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    invoke('pty:list', { sessionId })
      .then(async (list) => {
        if (cancelled) return;
        const alive = list.filter((t) => !t.exited);
        if (alive.length === 0) {
          await create();
          return;
        }
        setTerminals(alive);
        setActiveId(alive[0]?.id ?? null);
        setLoad({ state: 'ready' });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ state: 'error', message: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, create]);

  // A line asked for from outside the panel (a command in a reply) is typed into the terminal in front and never
  // run: it goes in without a line break. A session without a terminal gets one above, and the line waits for it.
  const [typed, setTyped] = useState(0);
  const [cleared, setCleared] = useState(0);
  const wanted = usePanels((s) => (s.terminalInput?.sessionId === sessionId ? s.terminalInput.seq : null));
  useEffect(() => {
    if (wanted === null || activeId === null) return;
    const line = usePanels.getState().takeTerminalInput(sessionId);
    if (line === null) return;
    invoke('pty:write', { id: activeId, data: line }).then(
      () => setTyped((n) => n + 1),
      (error: unknown) => reportError("Couldn't type into the terminal", error)
    );
  }, [wanted, activeId, sessionId]);

  const closeTab = async (id: string): Promise<void> => {
    try {
      await invoke('pty:kill', { id });
    } catch (error) {
      reportError("Couldn't close the terminal", error);
      return;
    }
    const rest = terminals.filter((t) => t.id !== id);
    setTerminals(rest);
    if (activeId === id) setActiveId(rest.at(-1)?.id ?? null);
    if (rest.length === 0) onClose();
  };

  return (
    <PanelFrame
      label="Terminal"
      onClose={onClose}
      title={
        <div role="tablist" aria-label="Terminals" className="flex min-w-0 items-center gap-2 overflow-x-auto">
          {terminals.map((t, i) => (
            <div
              key={t.id}
              className={cn('group flex h-24 shrink-0 items-center rounded-sm pr-2 pl-6 text-sm', t.id === activeId ? 'bg-hover text-fg' : 'text-fg-muted hover:text-fg-secondary')}
            >
              <button type="button" role="tab" aria-selected={t.id === activeId} onClick={() => setActiveId(t.id)} className="flex items-center gap-4">
                <SquareTerminal className="size-12" aria-hidden="true" />
                {i + 1} · {t.title}
              </button>
              <button
                type="button"
                aria-label={`Close terminal ${i + 1}`}
                onClick={() => void closeTab(t.id)}
                className="ml-2 flex size-16 items-center justify-center rounded-xs text-icon-muted opacity-0 transition-ui group-hover:opacity-100 hover:text-icon-strong focus-visible:opacity-100"
              >
                <X className="size-10" />
              </button>
            </div>
          ))}
        </div>
      }
      actions={
        <>
          <IconButton label="New terminal" size="xs" onClick={() => void create()}>
            <Plus className="size-14" />
          </IconButton>
          <TerminalOptions onClear={() => setCleared((n) => n + 1)} />
        </>
      }
    >
      {load.state === 'loading' ? <LoadingState label="Starting a shell…" /> : null}
      {load.state === 'error' ? <ErrorState title="Couldn't start a terminal" message={load.message} onRetry={() => void create()} /> : null}
      {terminals.map((t) => (
        <XtermView key={t.id} terminal={t} active={t.id === activeId} typed={typed} cleared={cleared} />
      ))}
    </PanelFrame>
  );
}
