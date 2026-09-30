import { errorText, invoke } from './ipc';

/** Records a renderer-side failure in the app log (main process), falling back to the console. */
export function logError(message: string, error?: unknown): void {
  const text = error === undefined ? message : `${message}: ${errorText(error)}`;
  const stack = error instanceof Error && error.stack ? error.stack.slice(0, 8000) : undefined;
  invoke('app:log', { level: 'error', message: text.slice(0, 4000), ...(stack ? { stack } : {}) }).catch((logFailure: unknown) => {
    console.error(text, error, logFailure);
  });
}
