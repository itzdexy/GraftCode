import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { errorText } from './ipc';

export type Load<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };

/**
 * Loads data for a view and reloads when `key` changes or `reload()` is
 * called. Keeps showing the previous data while a reload is in flight.
 */
export function useLoad<T>(fetcher: () => Promise<T>, key: string): { load: Load<T>; reload: () => void } {
  const [load, setLoad] = useState<Load<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const fetchRef = useRef(fetcher);
  useLayoutEffect(() => {
    fetchRef.current = fetcher;
  });
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetchRef
      .current()
      .then((data) => {
        if (!cancelled) setLoad({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [key, tick]);

  return { load, reload };
}
