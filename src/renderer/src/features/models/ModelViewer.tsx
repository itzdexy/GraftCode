import { useEffect, useRef, useState } from 'react';
import { Grid3x3, Pause, Play, RotateCcw, Rotate3d } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';
import { cn } from '../../lib/cn';
import { errorText, invoke } from '../../lib/ipc';
import { reducedMotion } from '../../lib/motion';
import { loadModel } from './loadModel';
import { sizeText, statsText, type ModelStats } from './modelFormats';
import { createModelView, type ModelView } from './viewer';

type ViewState =
  | { status: 'waiting' }
  | { status: 'loading' }
  | { status: 'ready'; stats: ModelStats; clips: string[] }
  | { status: 'error'; message: string }
  | { status: 'no-webgl' };

/** True once the element has come near the screen; a card further up the conversation waits until it is scrolled to. */
function useNearScreen(element: React.RefObject<HTMLElement>, enabled: boolean): boolean {
  const [near, setNear] = useState(!enabled);
  useEffect(() => {
    if (!enabled || near || !element.current) return;
    const watcher = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { rootMargin: '200px' });
    watcher.observe(element.current);
    return () => watcher.disconnect();
  }, [element, enabled, near]);
  return near;
}

export interface ModelViewerProps {
  sessionId: string;
  /** The model's path in the session's folder. */
  path: string;
  /** "card": in the conversation, drawn once it is scrolled near. */
  variant?: 'panel' | 'card';
}

/**
 * A 3D model from the session's folder, drawn with three.js: drag to turn
 * it, scroll to come closer, right-drag to move. It turns slowly by itself
 * until it is touched; its animations play, one at a time.
 */
export default function ModelViewer({ sessionId, path, variant = 'panel' }: ModelViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<ModelView | null>(null);
  const near = useNearScreen(host, variant === 'card');
  // Null while the model is on its way: then it is waiting to be scrolled near, or loading.
  const [outcome, setOutcome] = useState<Exclude<ViewState, { status: 'waiting' | 'loading' }> | null>(null);
  const state: ViewState = outcome ?? (near ? { status: 'loading' } : { status: 'waiting' });
  // With motion reduced the model holds still until it is turned by hand.
  const [turning, setTurning] = useState(() => !reducedMotion());
  const [wireframe, setWireframe] = useState(false);
  const [clip, setClip] = useState(0);
  const [playing, setPlaying] = useState(true);
  const name = path.slice(path.lastIndexOf('/') + 1);

  useEffect(() => {
    const element = host.current;
    if (!near || !element) return;
    let gone = false;
    let created: ModelView | null = null;
    Promise.resolve()
      .then(() => {
        // Throws where this computer can't draw with WebGL; that is told apart from a model that can't be read below.
        created = createModelView(element, { reducedMotion: reducedMotion(), light: document.documentElement.dataset.theme === 'light' });
        view.current = created;
        return loadModel((file) => invoke('files:modelBytes', { sessionId, path: file }), path);
      })
      .then((model) => {
        if (gone || !created) return;
        const stats = created.show(model);
        setOutcome({ status: 'ready', stats, clips: model.clips.map((c, i) => c.name || `Animation ${String(i + 1)}`) });
      })
      .catch((error: unknown) => {
        if (!gone) setOutcome(created ? { status: 'error', message: errorText(error) } : { status: 'no-webgl' });
      });
    return () => {
      gone = true;
      view.current = null;
      created?.dispose();
    };
  }, [sessionId, path, near]);

  const ready = state.status === 'ready';
  useEffect(() => view.current?.setAutoRotate(turning), [turning, ready]);
  useEffect(() => view.current?.setWireframe(wireframe), [wireframe, ready]);
  const clips = state.status === 'ready' ? state.clips.length : 0;
  useEffect(() => view.current?.playClip(clips > 0 ? clip : null), [clip, clips]);
  useEffect(() => view.current?.setPlaying(playing), [playing, ready]);

  return (
    <div
      role="group"
      aria-label={`3D view of ${name}`}
      className={cn('relative isolate overflow-hidden', variant === 'card' ? 'h-[340px]' : 'h-full min-h-[220px]')}
      style={{ background: 'radial-gradient(130% 95% at 50% 18%, var(--g-surface-raised) 0%, var(--g-surface-sunken) 72%)' }}
    >
      <div
        ref={host}
        // Pointer and wheel go to the camera; the page under it doesn't scroll while the model is being turned.
        className={cn('absolute inset-0 cursor-grab touch-none transition-opacity duration-[var(--g-duration-slow)] active:cursor-grabbing', ready ? 'opacity-100' : 'opacity-0')}
        onPointerDown={() => setTurning(false)}
      />
      {state.status === 'loading' || state.status === 'waiting' ? (
        <p role="status" className="absolute inset-0 flex items-center justify-center gap-8 text-sm text-fg-muted">
          <Spinner size={14} label="Loading the model" /> Loading the model…
        </p>
      ) : null}
      {state.status === 'error' ? (
        <p role="alert" className="absolute inset-0 flex items-center justify-center px-24 text-center text-sm text-fg-muted">
          {state.message}
        </p>
      ) : null}
      {state.status === 'no-webgl' ? (
        <p role="alert" className="absolute inset-0 flex items-center justify-center px-24 text-center text-sm text-fg-muted">
          This computer can't draw 3D in Graft right now (WebGL is off or unavailable). Open the file in Blender or another 3D app.
        </p>
      ) : null}
      {ready ? (
        <>
          <div role="toolbar" aria-label="3D view" className="motion-rise absolute bottom-8 left-8 flex items-center gap-2 rounded-md border border-border bg-surface/85 p-2 shadow-popover backdrop-blur-sm">
            <IconButton label={turning ? 'Stop turning' : 'Turn by itself'} size="sm" active={turning} aria-pressed={turning} onClick={() => setTurning(!turning)}>
              <Rotate3d className="size-14" />
            </IconButton>
            <IconButton label="Wireframe" size="sm" active={wireframe} aria-pressed={wireframe} onClick={() => setWireframe(!wireframe)}>
              <Grid3x3 className="size-14" />
            </IconButton>
            <IconButton label="Reset the view" size="sm" onClick={() => view.current?.resetView()}>
              <RotateCcw className="size-14" />
            </IconButton>
            {state.clips.length > 0 ? (
              <>
                <span aria-hidden="true" className="mx-2 h-16 w-px bg-border" />
                <IconButton label={playing ? 'Pause the animation' : 'Play the animation'} size="sm" onClick={() => setPlaying(!playing)}>
                  {playing ? <Pause className="size-14" /> : <Play className="size-14" />}
                </IconButton>
                {state.clips.length > 1 ? (
                  <select
                    aria-label="Animation"
                    value={clip}
                    onChange={(event) => {
                      setClip(Number(event.target.value));
                      setPlaying(true);
                    }}
                    className="h-24 max-w-[160px] truncate rounded-sm border border-border bg-input px-4 text-sm text-fg"
                  >
                    {state.clips.map((label, i) => (
                      <option key={`${String(i)}:${label}`} value={i}>
                        {label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="max-w-[140px] truncate px-4 text-sm text-fg-secondary">{state.clips[0]}</span>
                )}
              </>
            ) : null}
          </div>
          <p className="pointer-events-none absolute right-10 bottom-8 max-w-[55%] text-right text-xs text-fg-muted tabular-nums">
            <span className="block truncate">{statsText(state.stats)}</span>
            <span className="block truncate text-fg-faint">{sizeText(state.stats.size)}</span>
          </p>
        </>
      ) : null}
    </div>
  );
}
