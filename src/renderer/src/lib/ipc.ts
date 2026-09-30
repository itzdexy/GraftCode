import type { Channel, ChannelInput, ChannelOutput } from '@shared/ipc/contracts';
import type { GraftEvent } from '@shared/ipc/events';
import type { IpcResult } from '@shared/ipc/result';

/** Error raised in the renderer when a main-process request fails. */
export class RequestError extends Error {
  readonly code: string;
  readonly details: Record<string, string | number | boolean | null> | undefined;
  constructor(code: string, message: string, details?: Record<string, string | number | boolean | null>) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
    this.details = details;
  }
}

type Args<C extends Channel> = ChannelInput<C> extends void | undefined ? [] : [input: ChannelInput<C>];

/** Typed request to the main process. Rejects with RequestError on failure. */
export async function invoke<C extends Channel>(channel: C, ...args: Args<C>): Promise<ChannelOutput<C>> {
  const result = (await window.graft.invoke(channel, args[0])) as IpcResult<ChannelOutput<C>>;
  if (result.ok) return result.value;
  throw new RequestError(result.error.code, result.error.message, result.error.details);
}

/** Subscribes to main-process events; returns an unsubscribe function. */
export function onEvent(listener: (event: GraftEvent) => void): () => void {
  return window.graft.on((payload) => listener(payload as GraftEvent));
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
