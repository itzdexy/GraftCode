import fs from 'node:fs';
import path from 'node:path';
import type { ShellSpec } from '../tools/shell/detect';

/**
 * Graft's shell integration for the Terminal panel: bash, zsh and PowerShell print a mark where each prompt, typed
 * command and output starts, and one with the exit code when the command is done (OSC 133, see
 * shared/terminalMarks.ts), so the panel can tell commands apart. It goes in through the arguments and the
 * environment the shell starts with; the user's own startup files are read first and never changed.
 */

export interface ShellLaunch {
  args: string[];
  env: Record<string, string>;
  /** Files the shell reads as it starts, by name inside the integration folder. */
  files: Record<string, string>;
}

const BASH = `# Graft's shell integration: marks each prompt, command and exit code (OSC 133) for the Terminal panel.
# The startup files bash reads for a login shell run first, unchanged.
if [ -n "\${GRAFT_SHELL_LOGIN:-}" ]; then
  unset GRAFT_SHELL_LOGIN
  [ -r /etc/profile ] && . /etc/profile
  if [ -r ~/.bash_profile ]; then . ~/.bash_profile
  elif [ -r ~/.bash_login ]; then . ~/.bash_login
  elif [ -r ~/.profile ]; then . ~/.profile
  fi
else
  [ -r ~/.bashrc ] && . ~/.bashrc
fi
__graft_status() { __graft_code=$?; return $__graft_code; }
__graft_prompt() {
  printf '\\033]133;D;%s\\007\\033]133;A\\007\\033]133;P;Cwd=%s\\007' "$__graft_code" "$PWD"
  # A prompt rebuilt by the user's own prompt command gets its mark again.
  case $PS1 in *'133;B'*) ;; *) PS1=$PS1'\\[\\033]133;B\\007\\]' ;; esac
  return $__graft_code
}
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__graft_status "\${PROMPT_COMMAND[@]}" __graft_prompt)
else
  PROMPT_COMMAND=$'__graft_status\\n'"\${PROMPT_COMMAND:-}"$'\\n__graft_prompt'
fi
# Printed once a command line is read, before it runs; an empty line runs nothing and prints nothing.
PS0=\${PS0:-}'\\033]133;C\\007'
`;

/** One of zsh's startup files: it reads the user's file of that name, from where zsh would have read it. */
function zshFile(name: string, before: string[] = [], after: string[] = []): string {
  return [
    "# Graft's shell integration: zsh reads its startup files from this folder, and each of them reads the user's own.",
    ...before,
    'ZDOTDIR=${GRAFT_USER_ZDOTDIR:-$HOME}',
    `[[ -r $ZDOTDIR/${name} ]] && source $ZDOTDIR/${name}`,
    // The user's file may have moved ZDOTDIR: their next file is read from there, and zsh reads ours from here.
    'GRAFT_USER_ZDOTDIR=$ZDOTDIR',
    'ZDOTDIR=$GRAFT_ZDOTDIR',
    ...after,
    ''
  ].join('\n');
}

const ZSH_MARKS = [
  '__graft_status() { __graft_code=$?; }',
  '__graft_precmd() {',
  `  printf '\\e]133;D;%s\\a\\e]133;A\\a\\e]133;P;Cwd=%s\\a' "$__graft_code" "$PWD"`,
  '  # A prompt a theme rebuilds before each command gets its mark again.',
  `  [[ $PS1 == *'133;B'* ]] || PS1="$PS1"$'%{\\e]133;B\\a%}'`,
  '}',
  `__graft_preexec() { printf '\\e]133;C\\a'; }`,
  'precmd_functions=(__graft_status $precmd_functions __graft_precmd)',
  'preexec_functions+=(__graft_preexec)',
  "# A shell that is not a login shell reads no .zlogin: it gets the user's own folder back here.",
  '[[ -o login ]] || { ZDOTDIR=$GRAFT_USER_ZDOTDIR; unset GRAFT_USER_ZDOTDIR GRAFT_ZDOTDIR; }'
];

const ZSH_FILES: Record<string, string> = {
  'zsh/.zshenv': zshFile('.zshenv', ['GRAFT_ZDOTDIR=$ZDOTDIR']),
  'zsh/.zprofile': zshFile('.zprofile'),
  'zsh/.zshrc': zshFile('.zshrc', [], ZSH_MARKS),
  // The last file zsh reads: from here on it looks in the user's own folder, as if Graft had never been there.
  'zsh/.zlogin': zshFile('.zlogin', [], ['ZDOTDIR=$GRAFT_USER_ZDOTDIR', 'unset GRAFT_USER_ZDOTDIR GRAFT_ZDOTDIR'])
};

/**
 * Run after the profile, as the start command. The exit code is $LASTEXITCODE when a program set it, else 1 for a
 * PowerShell error: a code left over from an earlier program is not taken for this command's.
 */
const POWERSHELL = `$Global:__GraftPrompt = $function:prompt
function Global:prompt {
  $ok = $global:?
  $code = $global:LASTEXITCODE
  Set-StrictMode -Off
  $e = [char]27; $b = [char]7
  $out = ''
  $last = Get-History -Count 1
  if ($last -and $last.Id -ne $Global:__GraftLastId) {
    $Global:__GraftLastId = $last.Id
    $native = $code -is [int] -and $code -ne 0 -and ($code -ne $Global:__GraftExitBefore -or [object]::ReferenceEquals($Error[0], $Global:__GraftErrorBefore))
    $exit = if ($ok) { 0 } elseif ($native) { $code } else { 1 }
    $out += "$e]133;D;$exit$b"
  }
  $out += "$e]133;A$b"
  if ($pwd.Provider.Name -eq 'FileSystem') { $out += "$e]133;P;Cwd=$($pwd.ProviderPath)$b" }
  if (-not $ok) { Write-Error 'failed' -ErrorAction Ignore }
  $out += $Global:__GraftPrompt.Invoke()
  $out + "$e]133;B$b"
}
if (Get-Module -Name PSReadLine) {
  $Global:__GraftReadLine = $function:PSConsoleHostReadLine
  function Global:PSConsoleHostReadLine {
    Set-StrictMode -Off
    $line = $Global:__GraftReadLine.Invoke()
    if ("$line".Trim()) {
      $Global:__GraftExitBefore = $global:LASTEXITCODE
      $Global:__GraftErrorBefore = $Error[0]
      [Console]::Write("$([char]27)]133;C$([char]7)")
    }
    $line
  }
}
`;

/** The shell an executable is, by its name: Graft has marks for these three only. */
function integratedShell(file: string): 'bash' | 'zsh' | 'powershell' | null {
  const name = (/[^\\/]+$/.exec(file)?.[0] ?? '').toLowerCase().replace(/\.exe$/, '');
  if (name === 'bash' || name === 'zsh') return name;
  return name === 'pwsh' || name === 'powershell' ? 'powershell' : null;
}

/**
 * How a terminal tab starts its shell with the marks in place, or null for a shell Graft has none for (cmd.exe, sh
 * and anything else), which starts as it always did. `dir` is the folder the files go in; `env` is the
 * environment the shell would get (a ZDOTDIR the user set is still read).
 */
export function shellLaunch(shell: ShellSpec, dir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ShellLaunch | null {
  switch (integratedShell(shell.path)) {
    case 'bash': {
      // --init-file is read by a shell that is not a login shell, so the script reads the login files itself.
      // Git Bash reads a Windows path written with forward slashes.
      const file = path.join(dir, 'graft.bash');
      return { args: ['--init-file', platform === 'win32' ? file.replace(/\\/g, '/') : file, '-i'], env: { GRAFT_SHELL_LOGIN: '1' }, files: { 'graft.bash': BASH } };
    }
    case 'zsh':
      return { args: ['--login', '-i'], env: { ZDOTDIR: path.join(dir, 'zsh'), ...(env.ZDOTDIR ? { GRAFT_USER_ZDOTDIR: env.ZDOTDIR } : {}) }, files: ZSH_FILES };
    case 'powershell':
      // An encoded command rather than a script file: the execution policy may forbid running .ps1 files.
      return { args: ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(POWERSHELL, 'utf16le').toString('base64')], env: {}, files: {} };
    default:
      return null;
  }
}

/** Writes the launch's files, leaving one alone when it already says the same: a shell starting now may be reading it. */
export function writeLaunchFiles(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    try {
      if (fs.readFileSync(file, 'utf8') === content) continue;
    } catch {
      // Not there yet.
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  }
}
