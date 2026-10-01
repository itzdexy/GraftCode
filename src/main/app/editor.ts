import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { shell } from 'electron';
import { GraftError } from '@shared/errors';

/**
 * Opens a folder in VS Code when its `code` launcher is on PATH, otherwise in
 * the system file manager. The launcher is started detached so it outlives
 * nothing in Graft.
 */
export async function openInEditor(dir: string, codePath: string | null): Promise<'editor' | 'folder'> {
  if (!fs.existsSync(dir)) throw new GraftError('folder_missing', `The folder ${dir} no longer exists.`);
  // cmd.exe expands %VAR% even inside quotes, so such paths go to the file manager instead.
  const cmdSafe = process.platform !== 'win32' || !/["%!^]/.test(dir);
  if (codePath && cmdSafe) {
    const child =
      process.platform === 'win32'
        ? // code.cmd is a batch file; cmd.exe runs it. Windows paths cannot contain double quotes.
          spawn('cmd.exe', ['/d', '/s', '/c', `""${codePath}" "${dir}""`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true })
        : spawn(codePath, [dir], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return 'editor';
  }
  const error = await shell.openPath(dir);
  if (error) throw new GraftError('open_failed', error);
  return 'folder';
}
