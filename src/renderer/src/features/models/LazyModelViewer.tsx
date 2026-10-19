import { lazy, Suspense } from 'react';
import { Spinner } from '../../components/ContextRing';
import type { ModelViewerProps } from './ModelViewer';

// three.js is large, so the viewer loads the first time a model is shown.
const ModelViewer = lazy(() => import('./ModelViewer'));

export function LazyModelViewer(props: ModelViewerProps) {
  return (
    <Suspense
      fallback={
        <p role="status" className={props.variant === 'card' ? 'flex h-[340px] items-center justify-center gap-8 text-sm text-fg-muted' : 'flex h-full items-center justify-center gap-8 text-sm text-fg-muted'}>
          <Spinner size={14} label="Loading the 3D viewer" /> Loading the 3D viewer…
        </p>
      }
    >
      <ModelViewer {...props} />
    </Suspense>
  );
}
