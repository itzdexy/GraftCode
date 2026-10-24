import { useEffect, useState } from 'react';
import { logError } from '../../lib/log';
import type { MathPlugins } from './mathPlugins';

let loaded: MathPlugins | null = null;
let loading: Promise<MathPlugins> | null = null;

/** Fetches the math renderer once and keeps it. A fetch that fails is tried again by the next formula. */
export function loadMath(): Promise<MathPlugins> {
  loading ??= import('./mathPlugins').then(
    (module) => (loaded = module.MATH_PLUGINS),
    (error: unknown) => {
      loading = null;
      throw error;
    }
  );
  return loading;
}

/**
 * The math plugins once `wanted` has been true and they are in; null until
 * then, and the text is drawn as it was written meanwhile.
 */
export function useMath(wanted: boolean): MathPlugins | null {
  const [plugins, setPlugins] = useState(loaded);
  useEffect(() => {
    if (!wanted || plugins) return;
    let cancelled = false;
    loadMath().then(
      (ready) => {
        if (!cancelled) setPlugins(ready);
      },
      (error: unknown) => logError('The math renderer did not load', error)
    );
    return () => {
      cancelled = true;
    };
  }, [wanted, plugins]);
  return wanted ? plugins : null;
}
