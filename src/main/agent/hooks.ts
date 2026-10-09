import { spawn } from 'node:child_process';
import type { HookEvent } from '@shared/schemas/config';
import type { ScopedHook } from '../permissions/settingsStore';
import type { ShellSpec } from '../tools/shell/detect';
import { killProcessTree, msysToolsDir } from '../tools/shell/shellManager';

export interface HookRunResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface HookVerdict {
  /** "block": stop the action (or keep going, for Stop); "approve": skip the permission prompt. */
  decision: 'block' | 'approve' | 'none';
  reason: string | null;
  /** Extra text for the model (UserPromptSubmit / PostToolUse). */
  context: string | null;
  /** Non-blocking hook failures to surface as notices. */
  errors: string[];
}

/** Optional JSON a hook may print on stdout. */
interface HookJson {
  decision?: unknown;
  reason?: unknown;
  additionalContext?: unknown;
}

const EMPTY: HookVerdict = { decision: 'none', reason: null, context: null, errors: [] };

function matcherApplies(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === '*' || toolName === undefined) return true;
  return matcher.split('|').some((part) => {
    const p = part.trim();
    if (p.includes('*')) return new RegExp(`^${p.replace(/[.+?^${}()[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(toolName);
    return p === toolName;
  });
}

/**
 * Runs user-configured hook commands. Each command gets the event payload as
 * JSON on stdin. Exit 0 = continue (stdout may be JSON with decision/reason/
 * additionalContext); exit 2 = block with stderr as the reason; any other
 * exit is a non-blocking error.
 */
export class HookRunner {
  constructor(
    private readonly hooks: () => Partial<Record<HookEvent, ScopedHook[]>>,
    private readonly shell: ShellSpec,
    private readonly cwd: () => string,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  inDirectory(cwd: string): HookRunner {
    return new HookRunner(this.hooks, this.shell, () => cwd, this.platform);
  }

  has(event: HookEvent): boolean {
    return (this.hooks()[event]?.length ?? 0) > 0;
  }

  private runOne(command: string, payload: unknown, timeoutSec: number, signal: AbortSignal): Promise<HookRunResult> {
    return new Promise((resolve) => {
      const args =
        this.shell.kind === 'powershell'
          ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
          : [...(this.shell.kind === 'bash' ? ['--noprofile', '--norc'] : []), '-c', command];
      const child = spawn(this.shell.path, args, {
        cwd: this.cwd(),
        env: { ...process.env, GRAFT_PROJECT_DIR: this.cwd(), GRAFT_HOOK: '1' },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: this.platform !== 'win32'
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      const stop = (): void => {
        void killProcessTree(child, { platform: this.platform, msysTools: this.shell.kind === 'bash' ? msysToolsDir(this.shell.path) : null, pidFile: null });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutSec * 1000);
      signal.addEventListener('abort', stop, { once: true });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ command, exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        resolve({ command, exitCode: code, stdout, stderr, timedOut });
      });
      // A hook may exit without reading stdin (EPIPE); its exit code still decides the outcome.
      child.stdin.on('error', () => undefined);
      child.stdin.end(JSON.stringify(payload));
    });
  }

  async run(event: HookEvent, payload: Record<string, unknown>, signal: AbortSignal, toolName?: string): Promise<HookVerdict> {
    const matchers = (this.hooks()[event] ?? []).filter((m) => matcherApplies(m.matcher, toolName));
    if (matchers.length === 0) return EMPTY;
    const verdict: HookVerdict = { decision: 'none', reason: null, context: null, errors: [] };
    const contexts: string[] = [];
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        const result = await this.runOne(hook.command, { event, ...payload }, hook.timeout ?? 60, signal);
        if (result.timedOut) {
          verdict.errors.push(`${event} hook timed out: ${hook.command}`);
          continue;
        }
        if (result.exitCode === 2) {
          return { ...verdict, decision: 'block', reason: result.stderr.trim() || `Blocked by a ${event} hook.` };
        }
        if (result.exitCode !== 0) {
          verdict.errors.push(`${event} hook failed (exit ${String(result.exitCode)}): ${result.stderr.trim() || hook.command}`);
          continue;
        }
        const out = result.stdout.trim();
        if (out.length === 0) continue;
        let parsed: HookJson | null = null;
        if (out.startsWith('{')) {
          try {
            parsed = JSON.parse(out) as HookJson;
          } catch {
            parsed = null;
          }
        }
        if (parsed) {
          if (parsed.decision === 'block') {
            return { ...verdict, decision: 'block', reason: typeof parsed.reason === 'string' ? parsed.reason : `Blocked by a ${event} hook.` };
          }
          if (parsed.decision === 'approve') verdict.decision = 'approve';
          if (typeof parsed.additionalContext === 'string') contexts.push(parsed.additionalContext);
        } else if (event === 'UserPromptSubmit' || event === 'PostToolUse') {
          contexts.push(out);
        }
      }
    }
    verdict.context = contexts.length > 0 ? contexts.join('\n') : null;
    return verdict;
  }
}
