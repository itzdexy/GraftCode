import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC_EVENT, IPC_INVOKE, type IpcResult } from '../shared/ipc/result';

/**
 * The only surface the sandboxed renderer can reach. Every call is validated
 * again in main; this layer only forwards and never exposes ipcRenderer.
 */
const bridge = {
  invoke(channel: string, input?: unknown): Promise<IpcResult<unknown>> {
    if (typeof channel !== 'string') {
      return Promise.resolve({ ok: false, error: { code: 'invalid_channel', message: 'Channel must be a string.' } });
    }
    return ipcRenderer.invoke(IPC_INVOKE, channel, input) as Promise<IpcResult<unknown>>;
  },
  on(listener: (event: unknown) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload);
    ipcRenderer.on(IPC_EVENT, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT, wrapped);
    };
  },
  platform: process.platform
};

contextBridge.exposeInMainWorld('graft', bridge);
