import fs from 'node:fs';
import path from 'node:path';

export type ShellKind = 'bash' | 'zsh' | 'sh' | 'powershell';

export interface ShellSpec {
  kind: ShellKind;
  path: string;
  /** Short name for prompts and the UI, e.g. "Git Bash" or "PowerShell". */
  label: string;
}

type Exists = (p: string) => boolean;
const defaultExists: Exists = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function kindOf(file: string): ShellKind {
  const base = path.basename(file).toLowerCase().replace(/\.exe$/, '');
  if (base === 'pwsh' || base === 'powershell') return 'powershell';
  if (base === 'zsh') return 'zsh';
  if (base === 'sh' || base === 'dash') return 'sh';
  return 'bash';
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? '';
  return raw.split(path.delimiter).filter(Boolean);
}

/**
 * Picks the shell for the agent's Shell tool. Windows: Git Bash when
 * installed (never WSL's System32 bash), otherwise PowerShell. Elsewhere:
 * the user's bash/zsh, falling back to /bin/sh. GRAFT_SHELL overrides.
 */
export function detectShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: Exists = defaultExists): ShellSpec {
  const override = env.GRAFT_SHELL;
  if (override && exists(override)) {
    const kind = kindOf(override);
    return { kind, path: override, label: kind === 'powershell' ? 'PowerShell' : path.basename(override) };
  }
  if (platform === 'win32') {
    const candidates = [
      env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
      env['ProgramFiles(x86)'] && path.win32.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
      env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
      ...pathDirs(env)
        .filter((d) => exists(path.win32.join(d, 'git.exe')))
        .map((d) => path.win32.join(d, '..', 'bin', 'bash.exe'))
    ].filter((c): c is string => typeof c === 'string' && c.length > 0);
    const bash = candidates.find((c) => exists(c) && !/\\system32\\/i.test(c));
    if (bash) return { kind: 'bash', path: path.win32.normalize(bash), label: 'Git Bash' };
    const pwsh = pathDirs(env)
      .map((d) => path.win32.join(d, 'pwsh.exe'))
      .find(exists);
    if (pwsh) return { kind: 'powershell', path: pwsh, label: 'PowerShell' };
    const systemRoot = env.SystemRoot ?? 'C:\\Windows';
    return {
      kind: 'powershell',
      path: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      label: 'Windows PowerShell'
    };
  }
  const userShell = env.SHELL;
  if (userShell && /\/(bash|zsh)$/.test(userShell) && exists(userShell)) {
    return { kind: kindOf(userShell), path: userShell, label: path.basename(userShell) };
  }
  if (exists('/bin/bash')) return { kind: 'bash', path: '/bin/bash', label: 'bash' };
  return { kind: 'sh', path: '/bin/sh', label: 'sh' };
}
