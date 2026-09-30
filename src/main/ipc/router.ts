import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import {
  contracts,
  type Channel,
  type ChannelOutput,
  type ChannelParsedInput
} from '@shared/ipc/contracts';
import { IPC_INVOKE, type IpcResult } from '@shared/ipc/result';
import { GraftError, errorMessage } from '@shared/errors';
import { log } from '../app/log';

export type Handler<C extends Channel> = (
  input: ChannelParsedInput<C>,
  event: IpcMainInvokeEvent
) => ChannelOutput<C> | Promise<ChannelOutput<C>>;

export type HandlerGroup = { [C in Channel]?: Handler<C> };

const handlers = new Map<Channel, Handler<Channel>>();

function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(contracts, value);
}

/** Adds a group of handlers. A channel may only be registered once. */
export function registerHandlers(group: HandlerGroup): void {
  for (const key of Object.keys(group) as Channel[]) {
    if (handlers.has(key)) throw new Error(`IPC handler registered twice: ${key}`);
    handlers.set(key, group[key] as Handler<Channel>);
  }
}

/** Channels declared in contracts without a handler (used by startup checks and tests). */
export function missingHandlers(): Channel[] {
  return (Object.keys(contracts) as Channel[]).filter((c) => !handlers.has(c));
}

/**
 * Installs the single invoke entry point. `isTrustedSender` must confirm the
 * request comes from the app's own top-level renderer frame.
 */
export function installRouter(isTrustedSender: (contents: WebContents, frameUrl: string) => boolean): void {
  ipcMain.handle(IPC_INVOKE, async (event, rawChannel: unknown, rawInput: unknown): Promise<IpcResult<unknown>> => {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null || !isTrustedSender(event.sender, frame.url)) {
      log.warn('ipc', 'Rejected IPC from untrusted frame', { url: frame?.url ?? 'unknown' });
      return { ok: false, error: { code: 'forbidden', message: 'Request rejected.' } };
    }
    if (!isChannel(rawChannel)) {
      return { ok: false, error: { code: 'unknown_channel', message: 'Unknown request.' } };
    }
    const channel = rawChannel;
    const handler = handlers.get(channel);
    if (!handler) {
      return { ok: false, error: { code: 'not_implemented', message: `No handler for ${channel}.` } };
    }
    const parsed = contracts[channel].input.safeParse(rawInput);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
      return {
        ok: false,
        error: { code: 'invalid_input', message: `Invalid input for ${channel}${where}: ${issue?.message ?? 'invalid'}` }
      };
    }
    try {
      const value = await handler(parsed.data, event);
      return { ok: true, value };
    } catch (error) {
      if (error instanceof GraftError) {
        return {
          ok: false,
          error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
        };
      }
      log.error('ipc', `Handler failed: ${channel}`, { message: errorMessage(error) });
      return { ok: false, error: { code: 'internal', message: errorMessage(error) } };
    }
  });
}
