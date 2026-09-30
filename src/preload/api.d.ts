import type { IpcResult } from '../shared/ipc/result';

/** Shape of window.graft as exposed by src/preload/index.ts. */
export interface GraftBridge {
  invoke(channel: string, input?: unknown): Promise<IpcResult<unknown>>;
  on(listener: (event: unknown) => void): () => void;
  platform: string;
}

declare global {
  interface Window {
    graft: GraftBridge;
  }
}
