import { z } from 'zod';
import { errorResult, textResult, type ToolDefinition } from '../types';

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;

export const ShellInput = z.object({
  command: z.string().min(1).describe('The command to run.'),
  description: z.string().max(200).optional().describe('Five to ten words describing what the command does.'),
  timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT).optional().describe(`Timeout in ms (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}).`),
  run_in_background: z
    .boolean()
    .optional()
    .describe('Start without waiting (servers, watchers, long builds). Read output later with ShellOutput.')
});
export type ShellInput = z.infer<typeof ShellInput>;

export const shellTool: ToolDefinition<ShellInput> = {
  name: 'Shell',
  description: [
    'Run a shell command in the session working directory.',
    'The working directory and exported environment variables persist between calls.',
    'Output is truncated in the middle when very long; the full log is saved to disk.',
    'Commands cannot read interactive input. Prefer Read/Edit/Glob/Grep over cat/sed/find/grep.',
    'Use run_in_background for servers and watchers.'
  ].join(' '),
  input: ShellInput,
  permissionClass: 'exec',
  concurrencySafe: () => false,
  timeoutMs: MAX_TIMEOUT + 30_000,
  describe(input, ctx) {
    return Promise.resolve({
      summary: `Ran ${input.command.split('\n')[0]?.slice(0, 120) ?? ''}`,
      command: input.command,
      preview: { kind: 'command', command: input.command, cwd: ctx.cwd, background: input.run_in_background === true }
    });
  },
  async execute(input, ctx) {
    const cwd = ctx.shells.cwdFor(ctx.sessionId, ctx.cwd);
    if (input.run_in_background) {
      const job = ctx.shells.startBackground(ctx.sessionId, input.command, cwd);
      return textResult(`Started background shell ${job.id}. Read its output with ShellOutput (shell_id "${job.id}"); stop it with KillShell.`, {
        kind: 'shell',
        command: input.command,
        cwd,
        exitCode: null,
        output: '',
        truncated: false,
        logPath: job.logPath,
        durationMs: 0,
        timedOut: false,
        interrupted: false,
        backgroundId: job.id
      });
    }
    const result = await ctx.shells.run(ctx.sessionId, input.command, {
      cwd,
      timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT,
      signal: ctx.signal,
      onOutput: (chunk) => ctx.progress(chunk)
    });
    const status = result.timedOut
      ? `Timed out after ${Math.round((input.timeout_ms ?? DEFAULT_TIMEOUT) / 1000)}s; the process was stopped.`
      : result.interrupted
        ? 'Interrupted by the user.'
        : `Exit code ${result.exitCode ?? 'unknown'}.`;
    const moved = result.cwd !== cwd ? ` Working directory is now ${result.cwd}.` : '';
    const body = result.output.trim().length > 0 ? result.output.replace(/\s+$/, '') : '(no output)';
    return {
      isError: result.timedOut || (result.exitCode !== 0 && !result.interrupted),
      content: [{ type: 'text', text: `${body}\n\n${status}${moved}` }],
      display: {
        kind: 'shell',
        command: input.command,
        cwd,
        exitCode: result.exitCode,
        output: result.output.slice(-20_000),
        truncated: result.truncated,
        logPath: result.logPath,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        interrupted: result.interrupted,
        backgroundId: null
      }
    };
  }
};

export const ShellOutputInput = z.object({
  shell_id: z.string().min(1).describe('Id returned when the background shell started.'),
  filter: z.string().optional().describe('Only return lines matching this regular expression.')
});
export type ShellOutputInput = z.infer<typeof ShellOutputInput>;

export const shellOutputTool: ToolDefinition<ShellOutputInput> = {
  name: 'ShellOutput',
  description: 'Get new output from a background shell since the last check, plus whether it is still running.',
  input: ShellOutputInput,
  permissionClass: 'none',
  concurrencySafe: () => true,
  timeoutMs: 10_000,
  describe: (input) => Promise.resolve({ summary: `Checked background shell ${input.shell_id}` }),
  execute(input, ctx) {
    let filter: RegExp | undefined;
    if (input.filter) {
      try {
        filter = new RegExp(input.filter);
      } catch (error) {
        return Promise.resolve(errorResult(`Invalid filter regex: ${(error as Error).message}`));
      }
    }
    const read = ctx.shells.readOutput(input.shell_id, filter);
    if (!read || read.info.sessionId !== ctx.sessionId) return Promise.resolve(errorResult(`No background shell ${input.shell_id}.`));
    const { info } = read;
    const state =
      info.status === 'running' ? 'Still running.' : info.status === 'killed' ? 'Stopped.' : `Exited with code ${info.exitCode ?? 'unknown'}.`;
    const skipped = read.skipped > 0 ? `[${read.skipped} characters of older output were dropped; see ${info.logPath}]\n` : '';
    const text = `${skipped}${read.output.trim().length > 0 ? read.output : '(no new output)'}\n\n${state}`;
    return Promise.resolve(
      textResult(text, {
        kind: 'shell-output',
        shellId: info.id,
        status: info.status,
        exitCode: info.exitCode,
        output: read.output.slice(-10_000)
      })
    );
  }
};

export const KillShellInput = z.object({ shell_id: z.string().min(1) });
export type KillShellInput = z.infer<typeof KillShellInput>;

export const killShellTool: ToolDefinition<KillShellInput> = {
  name: 'KillShell',
  description: 'Stop a running background shell and its child processes.',
  input: KillShellInput,
  permissionClass: 'none',
  concurrencySafe: () => true,
  timeoutMs: 10_000,
  describe: (input) => Promise.resolve({ summary: `Stopped background shell ${input.shell_id}` }),
  async execute(input, ctx) {
    const known = ctx.shells.list(ctx.sessionId).some((s) => s.id === input.shell_id);
    if (!known) return errorResult(`No background shell ${input.shell_id}.`);
    const killed = await ctx.shells.kill(input.shell_id);
    return textResult(killed ? `Stopped ${input.shell_id}.` : `${input.shell_id} had already finished.`, {
      kind: 'kill-shell',
      shellId: input.shell_id,
      killed
    });
  }
};
