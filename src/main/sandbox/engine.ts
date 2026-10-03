import os from 'node:os';
import { findCommand } from '../mcp/integrations';
import { runFile } from '../tools/run';

/** A container engine that is installed and running. */
export interface ContainerEngine {
  kind: 'docker' | 'podman';
  path: string;
  version: string;
  /** CPUs the engine can hand out (Docker Desktop's VM may have fewer than the computer). */
  cpus: number;
  /** Rootless engines map root in the container to the user, so files it writes stay the user's. */
  rootless: boolean;
}

export type EngineProbe =
  | { status: 'ready'; engine: ContainerEngine }
  | { status: 'missing' }
  | { status: 'stopped'; kind: ContainerEngine['kind']; path: string; detail: string };

export type Runner = typeof runFile;

const PROBE_TIMEOUT_MS = 20_000;

async function probeOne(kind: ContainerEngine['kind'], file: string, run: Runner): Promise<EngineProbe> {
  // One call answers both questions: is the engine up, and what can it give us.
  const format = kind === 'docker' ? '{{.ServerVersion}}|{{.NCPU}}|{{json .SecurityOptions}}' : '{{.Version.Version}}|{{.Host.CPUs}}|{{.Host.Security.Rootless}}';
  let result;
  try {
    result = await run(file, ['info', '--format', format], { cwd: os.homedir(), timeoutMs: PROBE_TIMEOUT_MS });
  } catch (error) {
    return { status: 'stopped', kind, path: file, detail: (error as Error).message };
  }
  const [version = '', cpus = '', security = ''] = result.stdout.trim().split('|');
  if (result.code !== 0 || version.length === 0 || version === '<no value>') {
    const detail = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(-3).join(' ');
    return { status: 'stopped', kind, path: file, detail };
  }
  return {
    status: 'ready',
    engine: {
      kind,
      path: file,
      version,
      cpus: Math.max(1, Number.parseInt(cpus, 10) || 1),
      rootless: kind === 'docker' ? security.includes('rootless') : security.trim() === 'true'
    }
  };
}

/**
 * Finds a container engine for the sandbox: Docker, then Podman. A running
 * engine wins over an installed one that is stopped, so someone with both
 * still gets a sandbox when only Podman is up.
 */
export async function probeEngine(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, run: Runner = runFile): Promise<EngineProbe> {
  let stopped: EngineProbe | null = null;
  for (const kind of ['docker', 'podman'] as const) {
    const file = findCommand(kind, platform, env);
    if (!file) continue;
    const probe = await probeOne(kind, file, run);
    if (probe.status === 'ready') return probe;
    stopped ??= probe;
  }
  return stopped ?? { status: 'missing' };
}

/** What to tell someone whose engine can't run the sandbox. */
export function engineProblem(probe: EngineProbe, platform: NodeJS.Platform): string | null {
  if (probe.status === 'ready') return null;
  if (probe.status === 'missing') {
    return platform === 'linux'
      ? 'The sandbox needs Docker or Podman. Install one of them, then try again.'
      : 'The sandbox needs Docker Desktop or Podman. Install one of them, start it, then try again.';
  }
  const name = probe.kind === 'docker' ? (platform === 'linux' ? 'Docker' : 'Docker Desktop') : 'Podman';
  const start = probe.kind === 'podman' && platform !== 'linux' ? 'Start its machine (podman machine start)' : `Start ${name}`;
  return `${name} is installed but not running. ${start}, then try again.`;
}
