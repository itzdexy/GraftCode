import { splitCommand, stripPrefixes, words } from './commandParse';

/**
 * Detects actions that are destructive, irreversible, outward-facing or touch
 * credentials. A match is never auto-approved in any mode.
 */
interface CommandCheck {
  reason: string;
  test: (w: string[], segment: string) => boolean;
}

const lower = (w: string[]): string[] => w.map((x) => x.toLowerCase());
const hasFlag = (w: string[], ...flags: string[]): boolean =>
  w.some((x) => flags.includes(x) || (/^-[a-zA-Z]+$/.test(x) && flags.some((f) => /^-[a-zA-Z]$/.test(f) && x.includes(f.slice(1)))));
const cmd = (w: string[]): string => (w[0] ?? '').toLowerCase().replace(/\.exe$/, '').split(/[\\/]/).pop() ?? '';

const COMMAND_CHECKS: CommandCheck[] = [
  { reason: 'Recursively deletes files', test: (w) => cmd(w) === 'rm' && hasFlag(w, '-r', '-R', '--recursive') },
  { reason: 'Recursively deletes files', test: (w) => ['rmdir', 'rd', 'del', 'erase'].includes(cmd(w)) && lower(w).some((x) => x === '/s') },
  { reason: 'Recursively deletes files', test: (w) => ['remove-item', 'rm', 'ri', 'del', 'rmdir'].includes(cmd(w)) && lower(w).some((x) => x.startsWith('-rec')) },
  { reason: 'Recursively deletes files', test: (w) => cmd(w) === 'rimraf' || (cmd(w) === 'npx' && (w[1] ?? '').toLowerCase() === 'rimraf') },
  { reason: 'Recursively deletes files', test: (w) => cmd(w) === 'find' && lower(w).includes('-delete') },
  { reason: 'Force-pushes git history', test: (w) => cmd(w) === 'git' && w.includes('push') && (hasFlag(w, '-f', '--force', '--force-with-lease') || w.some((x, i) => i > 1 && x.startsWith('+'))) },
  { reason: 'Discards uncommitted work', test: (w) => cmd(w) === 'git' && w[1] === 'reset' && w.includes('--hard') },
  { reason: 'Discards uncommitted work', test: (w) => cmd(w) === 'git' && w[1] === 'clean' && w.slice(2).some((x) => /^-[a-z]*f/i.test(x) || x === '--force') },
  { reason: 'Discards uncommitted work', test: (w) => cmd(w) === 'git' && (w[1] === 'checkout' || w[1] === 'restore') && (w.includes('.') || w.includes('--') && w.includes('.')) },
  { reason: 'Deletes git branches or stashes', test: (w) => cmd(w) === 'git' && ((w[1] === 'branch' && hasFlag(w, '-D', '--delete') && w.includes('--force')) || (w[1] === 'branch' && w.includes('-D')) || (w[1] === 'stash' && (w[2] === 'drop' || w[2] === 'clear'))) },
  { reason: 'Rewrites git history', test: (w) => cmd(w) === 'git' && (w[1] === 'filter-branch' || w[1] === 'filter-repo' || (w[1] === 'reflog' && w[2] === 'expire')) },
  { reason: 'Publishes a package', test: (w) => ['npm', 'pnpm', 'yarn', 'bun'].includes(cmd(w)) && w[1] === 'publish' },
  { reason: 'Publishes a package', test: (w) => (cmd(w) === 'cargo' && w[1] === 'publish') || (cmd(w) === 'twine' && w[1] === 'upload') || (cmd(w) === 'gem' && w[1] === 'push') },
  { reason: 'Runs with elevated privileges', test: (w) => ['sudo', 'su', 'doas', 'runas'].includes(cmd(w)) || (cmd(w) === 'start-process' && lower(w).includes('runas')) },
  { reason: 'Changes permissions recursively', test: (w) => ['chmod', 'chown', 'chgrp', 'icacls', 'takeown'].includes(cmd(w)) && lower(w).some((x) => x === '-r' || x === '/t' || x === '/r' || x === '--recursive') },
  { reason: 'Formats or overwrites a disk', test: (w) => ['mkfs', 'diskpart', 'format', 'fdisk', 'parted', 'wipefs', 'format-volume', 'clear-disk'].includes(cmd(w)) || cmd(w).startsWith('mkfs.') },
  { reason: 'Formats or overwrites a disk', test: (w) => cmd(w) === 'dd' && w.some((x) => /^of=\/dev\//.test(x)) },
  { reason: 'Shuts down or reboots the machine', test: (w) => ['shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer'].includes(cmd(w)) },
  { reason: 'Stops other processes', test: (w) => ['killall', 'pkill'].includes(cmd(w)) || (cmd(w) === 'taskkill' && lower(w).includes('/im')) || (cmd(w) === 'kill' && w.includes('-1')) },
  { reason: 'Changes system configuration', test: (w) => ['reg', 'bcdedit', 'vssadmin', 'setx', 'netsh', 'sc', 'schtasks', 'crontab', 'launchctl', 'systemctl'].includes(cmd(w)) && !(cmd(w) === 'systemctl' && w[1] === 'status') },
  { reason: 'Changes global git configuration', test: (w) => cmd(w) === 'git' && w[1] === 'config' && (w.includes('--global') || w.includes('--system')) }
];

const PIPE_TO_SHELL = /(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|python\d?|node|perl|ruby|iex|invoke-expression|pwsh|powershell)\b/i;
const EXPR_DOWNLOAD = /(iex|invoke-expression)\s*\(?\s*(\(|\$\()?\s*(iwr|irm|invoke-webrequest|invoke-restmethod|new-object\s+net\.webclient)/i;
const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;
const RAW_DEVICE_WRITE = />\s*\/dev\/(sd|nvme|hd|disk)/;

/** Paths holding credentials or secrets. Reading or writing them is never automatic. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|[\\/])\.aws[\\/](credentials|config)$/i,
  /(^|[\\/])\.azure([\\/]|$)/i,
  /(^|[\\/])\.config[\\/]gcloud([\\/]|$)/i,
  /(^|[\\/])\.kube[\\/]config$/i,
  /(^|[\\/])\.docker[\\/]config\.json$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])_netrc$/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.pypirc$/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.env(\.[\w.-]+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|[\\/])credentials\.json$/i,
  /(^|[\\/])secrets?\.(json|ya?ml|toml)$/i,
  /(^|[\\/])Login Data$/i,
  /(^|[\\/])Cookies$/i
];

export function isCredentialPath(p: string): boolean {
  // .env.example / .env.sample / .env.template are documentation, not secrets.
  if (/(^|[\\/])\.env\.(example|sample|template|dist)$/i.test(p)) return false;
  return CREDENTIAL_PATTERNS.some((re) => re.test(p));
}

/** Commands that run another command given as their remaining arguments. */
const WRAPPERS = new Set(['xargs', 'timeout', 'sudo', 'doas', 'nohup', 'nice', 'time', 'watch', 'exec', 'parallel', 'busybox', 'env', 'stdbuf', 'ionice', 'chroot']);
/** Shells whose -c / /c / -Command argument is itself a command line. */
const NESTED_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh', 'wsl']);

/** The word lists to check for one simple command: itself plus every wrapped inner command. */
function commandViews(w: string[]): string[][] {
  const views: string[][] = [w];
  for (let i = 0; i < w.length - 1; i++) {
    const name = cmd([w[i]!]);
    if (!WRAPPERS.has(name)) continue;
    let j = i + 1;
    // Skip the wrapper's own options and a leading duration/count argument.
    while (j < w.length && (w[j]!.startsWith('-') || /^\d+[smhd]?$/.test(w[j]!))) j++;
    if (j < w.length) views.push(w.slice(j));
  }
  return views;
}

function nestedCommandLine(w: string[]): string | null {
  const name = cmd(w);
  if (!NESTED_SHELLS.has(name)) return null;
  const flagIndex = w.findIndex((x, i) => i > 0 && /^(-c|\/c|\/k|-command|-c(ommand)?|-encodedcommand)$/i.test(x));
  if (flagIndex === -1) return name === 'wsl' ? w.slice(1).join(' ') : null;
  return w.slice(flagIndex + 1).join(' ');
}

/** Returns a reason when a shell command is destructive or risky, else null. */
export function dangerousCommand(command: string, depth = 0): string | null {
  if (PIPE_TO_SHELL.test(command) || EXPR_DOWNLOAD.test(command)) return 'Pipes a download into a shell';
  if (FORK_BOMB.test(command)) return 'Fork bomb';
  if (RAW_DEVICE_WRITE.test(command)) return 'Formats or overwrites a disk';
  const { segments } = splitCommand(command);
  for (const segment of segments) {
    const base = words(stripPrefixes(segment));
    if (base.length === 0) continue;
    for (const w of commandViews(base)) {
      for (const check of COMMAND_CHECKS) if (check.test(w, segment)) return check.reason;
      const nested = nestedCommandLine(w);
      if (nested && depth < 3) {
        const inner = dangerousCommand(nested, depth + 1);
        if (inner) return inner;
      }
    }
    const credential = base.slice(1).find((x) => isCredentialPath(x.replace(/^[-\w]+=/, '')));
    if (credential) return 'Accesses credentials or secrets';
  }
  return null;
}
