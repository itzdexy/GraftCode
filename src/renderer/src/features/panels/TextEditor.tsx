import { useEffect, useRef, useState } from 'react';
import type { CodeLocation, SemanticResult } from '@shared/schemas/semantic';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import { useApp } from '../../stores/app';
import { languageForPath } from '../../lib/highlight';
import { errorText, invoke } from '../../lib/ipc';
import { Button } from '../../components/Button';
import { Markdown } from '../session/Markdown';

// Bundled Vite workers use local URLs allowed by the existing CSP; no CDN/eval is needed.
const editorGlobal = globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker(): Worker } };
editorGlobal.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export default function TextEditor({ sessionId, file, value, position, onChange, onSave, onNavigate }: {
  sessionId: string; file: string; value: string; position: CodeLocation | null;
  onChange: (value: string) => void; onSave: () => void; onNavigate: (location: CodeLocation) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const callbacks = useRef({ onChange, onSave, onNavigate });
  useEffect(() => { callbacks.current = { onChange, onSave, onNavigate }; }, [onChange, onSave, onNavigate]);
  const epoch = useRef(0);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<NonNullable<SemanticResult['diagnostics']>>([]);
  const [references, setReferences] = useState<CodeLocation[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const supported = /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file);
  const query = async (action: 'diagnostics' | 'definition' | 'references' | 'hover'): Promise<void> => {
    const instance = editor.current, model = instance?.getModel();
    if (!instance || !model || busy.current || !supported) return;
    const version = epoch.current;
    const cursor = instance.getPosition();
    busy.current = true; setPending(true); setFailure(null); setStatus(null); setReferences([]); setHover(null);
    try {
      const result = await invoke('files:semantic', { sessionId, query: { action, file, line: cursor?.lineNumber, column: cursor?.column },
        content: model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true) });
      if (version !== epoch.current || model.isDisposed()) return;
      if (action === 'definition') {
        if (result.locations?.[0]) callbacks.current.onNavigate(result.locations[0]);
        else setStatus('No definition found in this project.');
      } else if (action === 'references') {
        const locations = result.locations ?? [];
        setReferences(locations);
        setStatus(`${locations.length} reference${locations.length === 1 ? '' : 's'} found${result.truncated ? ' (truncated)' : ''}.`);
      } else if (action === 'hover') {
        setHover(result.hover || null);
        setStatus(result.hover ? 'Symbol information from TypeScript.' : 'No symbol information at this position.');
      } else {
        const findings = result.diagnostics ?? [];
        setDiagnostics(findings);
        monaco.editor.setModelMarkers(model, 'graft-typescript', findings.map((d) => ({
          startLineNumber: d.line, endLineNumber: d.line, startColumn: d.column, endColumn: d.column + 1,
          message: d.message, code: d.code === null ? undefined : String(d.code),
          severity: d.severity === 1 ? monaco.MarkerSeverity.Error : d.severity === 2 ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Hint
        })));
        setStatus(`Type check complete: ${findings.length} issue${findings.length === 1 ? '' : 's'}${result.truncated ? ' (truncated)' : ''}.`);
      }
    } catch (error) { if (version === epoch.current && !model.isDisposed()) setFailure(errorText(error)); }
    finally { busy.current = false; if (!model.isDisposed()) setPending(false); }
  };
  const runQuery = useRef(query);
  useEffect(() => { runQuery.current = query; });
  const appearance = useApp((s) => s.settings?.appearance);
  useEffect(() => {
    if (!container.current) return;
    const language = languageForPath(file);
    const model = monaco.editor.createModel(value, language === 'ts' || language === 'tsx' ? 'typescript' : language === 'js' || language === 'jsx' ? 'javascript' : language ?? undefined);
    const instance = monaco.editor.create(container.current, { model, automaticLayout: true,
      ariaLabel: `Edit ${file}`, fontFamily: '"JetBrains Mono Variable", monospace', fontSize: appearance?.codeFontSize ?? 13,
      minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: 'on', tabSize: 2,
      accessibilitySupport: 'on', fixedOverflowWidgets: true, padding: { top: 8, bottom: 8 } });
    editor.current = instance;
    if (position) { instance.setPosition({ lineNumber: position.line, column: position.column }); instance.revealLineInCenter(position.line); instance.focus(); }
    const changes = model.onDidChangeContent(() => {
      epoch.current++; setDiagnostics([]); setReferences([]); setHover(null); setStatus(null); setFailure(null); monaco.editor.setModelMarkers(model, 'graft-typescript', []);
      callbacks.current.onChange(model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true));
    });
    const save = instance.addAction({ id: 'graft.save', label: 'Save file', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => callbacks.current.onSave() });
    const check = instance.addAction({ id: 'graft.check', label: 'Check types', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyM], run: () => runQuery.current('diagnostics') });
    const definition = instance.addAction({ id: 'graft.definition', label: 'Go to definition', keybindings: [monaco.KeyCode.F12], run: () => runQuery.current('definition') });
    const referencesAction = instance.addAction({ id: 'graft.references', label: 'Find references', keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12], run: () => runQuery.current('references') });
    const hoverAction = instance.addAction({ id: 'graft.hover', label: 'Symbol information', keybindings: [monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI)], run: () => runQuery.current('hover') });
    const theme = (): void => {
      const css = getComputedStyle(container.current!);
      const color = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
      monaco.editor.defineTheme('graft-editor', { base: document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark', inherit: true, rules: [],
        colors: { 'editor.background': color('--g-code-block-bg', document.documentElement.dataset.theme === 'light' ? '#fafafa' : '#151515') } });
      monaco.editor.setTheme('graft-editor');
    };
    theme();
    const observer = new MutationObserver(theme); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette', 'data-accent'] });
    return () => { observer.disconnect(); changes.dispose(); save.dispose(); check.dispose(); definition.dispose(); referencesAction.dispose(); hoverAction.dispose(); instance.dispose(); model.dispose(); editor.current = null; };
    // The model owns edits. Recreate it only for another file; content changes flow through onChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);
  useEffect(() => { editor.current?.updateOptions({ fontSize: appearance?.codeFontSize ?? 13 }); }, [appearance?.codeFontSize]);
  return <div className="flex h-full min-h-[140px] w-full flex-col">
    <div ref={container} className="min-h-0 flex-1" />
    {supported ? <div className="max-h-[40%] shrink-0 overflow-auto border-t border-border px-8 py-4">
      <div className="flex flex-wrap items-center gap-6">
        <Button size="xs" variant="ghost" disabled={pending} onClick={() => void query('diagnostics')} title="Check the current draft (Ctrl+Shift+M)">Check types</Button>
        <Button size="xs" variant="ghost" disabled={pending} onClick={() => void query('definition')} title="Go to definition at the cursor (F12)">Definition</Button>
        <Button size="xs" variant="ghost" disabled={pending} onClick={() => void query('references')} title="Find references at the cursor (Shift+F12)">References</Button>
        <Button size="xs" variant="ghost" disabled={pending} onClick={() => void query('hover')} title="Symbol information at the cursor (Ctrl+K, Ctrl+I)">Symbol info</Button>
        <p role="status" className="text-2xs text-fg-muted">{pending ? 'Checking language server…' : status}</p>
      </div>
      {failure ? <p role="alert" className="text-sm text-danger">{failure}</p> : null}
      {hover ? <section aria-label="Symbol information" className="px-4 py-6"><Markdown text={hover} variant="code" /></section> : null}
      {references.length ? <ul aria-label="Symbol references" className="text-2xs">
        {references.slice(0, 100).map((location, i) => <li key={`${location.file}:${location.line}:${location.column}:${i}`}><button className="w-full truncate py-4 text-left font-mono text-fg-muted hover:text-fg" title={`${location.file}:${location.line}:${location.column}`} onClick={() => callbacks.current.onNavigate(location)}>{location.file}:{location.line}:{location.column}</button></li>)}
        {references.length > 100 ? <li>Showing the first 100 references.</li> : null}
      </ul> : null}
      {diagnostics.length ? <ul aria-label="Type diagnostics" className="text-2xs">
        {diagnostics.slice(0, 20).map((d, i) => <li key={i}><button className="w-full py-4 text-left text-fg-muted hover:text-fg" onClick={() => {
          editor.current?.setPosition({ lineNumber: d.line, column: d.column }); editor.current?.revealLineInCenter(d.line); editor.current?.focus();
        }}>{d.line}:{d.column} {d.code === null ? '' : `TS${String(d.code)}: `}{d.message}</button></li>)}
        {diagnostics.length > 20 ? <li>Showing the first 20 issues; all reported locations are marked in the editor.</li> : null}
      </ul> : null}
    </div> : null}
  </div>;
}
