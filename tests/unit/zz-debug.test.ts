import { execFile } from 'node:child_process';
import { it } from 'vitest';
import { makeShellManager } from '../support/toolContext';
import { makeTempDir } from '../support/tmp';

it('debug kill', async () => {
  const dir = makeTempDir();
  const mgr = makeShellManager(dir + '/.logs');
  const t0 = Date.now();
  const origExec = execFile;
  void origExec;
  const p = mgr.run('s', 'sleep 30', { cwd: dir, timeoutMs: 1500, signal: new AbortController().signal });
  setTimeout(() => {
    execFile('tasklist', ['/fo', 'csv', '/nh'], (e, out) => console.log('bash/sleep procs:', out.split('\n').filter((l) => /bash|sleep/i.test(l)).join(' | ')));
  }, 2500);
  const r = await p;
  console.log('done after', Date.now() - t0, 'timedOut', r.timedOut, 'exit', r.exitCode);
}, 40000);
