import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentWorkspaces } from '../../src/main/agent/workspaces';
import { CheckpointService } from '../../src/main/git/checkpoints';
import { openDatabase, type Db } from '../../src/main/db/database';
import { gitSync, makeRepo } from '../support/gitRepo';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

let root: string;
let db: Db;
let manager: AgentWorkspaces;
const projects: string[] = [];
const signal = (): AbortSignal => new AbortController().signal;
beforeEach(() => {
  root = makeTempDir(); db = openDatabase(path.join(root, 'graft.db'));
  manager = new AgentWorkspaces(new CheckpointService(db, path.join(root, 'shadows')), path.join(root, 'writers'));
});
afterEach(() => { db.close(); removeDir(root); for (const dir of projects.splice(0)) removeDir(dir); });
function project(git = false): string {
  const dir = git ? makeRepo() : makeTempDir(); projects.push(dir);
  writeFile(dir, 'a.txt', 'original a\n'); writeFile(dir, 'b.txt', 'original b\n');
  return dir;
}

describe('private writing-agent workspaces', () => {
  it('starts from current uncommitted files and leaves the destination HEAD and staging untouched', async () => {
    const dir = project(true);
    gitSync(dir, 'add', 'a.txt');
    const staged = gitSync(dir, 'diff', '--cached');
    const head = gitSync(dir, 'rev-parse', 'HEAD');
    const lease = await manager.create(dir, signal());
    expect(fs.readFileSync(path.join(lease.cwd, 'a.txt'), 'utf8')).toBe('original a\n');
    writeFile(lease.cwd, 'a.txt', 'private a\n');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('original a\n');
    expect((await manager.integrate(lease, ['a.txt'], signal())).state).toBe('integrated');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('private a\n');
    expect(gitSync(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(gitSync(dir, 'diff', '--cached')).toBe(staged);
    expect(fs.existsSync(lease.info.patchPath!)).toBe(true);
  });

  it('runs two writers in different checkouts and integrates disjoint changes without leaking intermediate writes', async () => {
    const dir = project();
    const [a, b] = await Promise.all([manager.create(dir, signal()), manager.create(dir, signal())]);
    expect(a.cwd).not.toBe(b.cwd); expect(a.info.branch).not.toBe(b.info.branch);
    writeFile(a.cwd, 'a.txt', 'agent a\n'); writeFile(b.cwd, 'b.txt', 'agent b\n');
    expect(fs.readFileSync(path.join(b.cwd, 'a.txt'), 'utf8')).toBe('original a\n');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('original a\n');
    await Promise.all([manager.integrate(a, ['a.txt'], signal()), manager.integrate(b, ['b.txt'], signal())]);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('agent a\n');
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('agent b\n');
  });

  it('preserves user changes and the entire writer patch when a destination conflicts', async () => {
    const dir = project(); const lease = await manager.create(dir, signal());
    writeFile(lease.cwd, 'a.txt', 'agent a\n'); writeFile(lease.cwd, 'b.txt', 'agent b\n');
    writeFile(dir, 'a.txt', 'user edit\n');
    await expect(manager.integrate(lease, [], signal())).rejects.toMatchObject({ code: 'agent_workspace_conflict' });
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('user edit\n');
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('original b\n');
    expect(lease.info.state).toBe('retained');
    expect(fs.readFileSync(lease.info.patchPath!, 'utf8')).toContain('agent b');
  });

  it('refuses out-of-scope changes made by a shell before integrating anything', async () => {
    const dir = project(); const lease = await manager.create(dir, signal());
    writeFile(lease.cwd, 'a.txt', 'own edit'); writeFile(lease.cwd, 'b.txt', 'outside edit');
    await expect(manager.integrate(lease, ['a.txt'], signal())).rejects.toMatchObject({ code: 'agent_scope_conflict' });
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('original b\n');
    expect(lease.info.state).toBe('retained');
  });

  it('does not silently omit an explicit edit to an ignored file', async () => {
    const dir = project(); writeFile(dir, '.gitignore', '.env\n'); writeFile(dir, '.env', 'private existing secret');
    const lease = await manager.create(dir, signal());
    expect(fs.existsSync(path.join(lease.cwd, '.env'))).toBe(false);
    writeFile(lease.cwd, '.env', 'new private content');
    await expect(manager.integrate(lease, [], signal(), ['.env'])).rejects.toMatchObject({ code: 'agent_ignored_change' });
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('private existing secret');
  });

  it('preserves CRLF and binary bytes through private shadow repositories on older Git', async () => {
    const dir = project(); writeFile(dir, 'crlf.txt', 'first\r\nsecond\r\n');
    manager = new AgentWorkspaces(new CheckpointService(db, path.join(root, 'old-shadows'), undefined, () => Promise.resolve(false)), path.join(root, 'writers'));
    const lease = await manager.create(dir, signal());
    expect(fs.readFileSync(path.join(lease.cwd, 'crlf.txt'))).toEqual(Buffer.from('first\r\nsecond\r\n'));
    const binary = Buffer.from([0, 255, 17, 128, 1]); writeFile(lease.cwd, 'new.bin', binary);
    await manager.integrate(lease, [], signal());
    expect(fs.readFileSync(path.join(dir, 'new.bin'))).toEqual(binary);
  });

  it('retains cancelled work and its manifest across manager restart', async () => {
    const dir = project(); const lease = await manager.create(dir, signal());
    writeFile(lease.cwd, 'a.txt', 'unfinished');
    const controller = new AbortController(); controller.abort();
    await expect(manager.integrate(lease, [], controller.signal)).rejects.toThrow();
    manager.retain(lease);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'writers', `${lease.id}.json`), 'utf8')) as { info: { state: string; path: string } };
    expect(manifest.info.state).toBe('retained');
    expect(fs.readFileSync(path.join(manifest.info.path, 'a.txt'), 'utf8')).toBe('unfinished');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('original a\n');
  });

  it('keeps a project opened below the repository root in the same relative directory', async () => {
    const dir = project(true); writeFile(dir, 'packages/app/code.txt', 'before');
    const lease = await manager.create(path.join(dir, 'packages', 'app'), signal());
    expect(lease.cwd).toBe(path.join(lease.root, 'packages', 'app'));
    writeFile(lease.cwd, 'code.txt', 'after');
    await manager.integrate(lease, ['code.txt'], signal());
    expect(fs.readFileSync(path.join(dir, 'packages', 'app', 'code.txt'), 'utf8')).toBe('after');
  });

  it('preserves exact modern-Git CRLF edits with project attributes', async () => {
    const dir = project(true); writeFile(dir, '.gitattributes', '*.txt text=auto\n');
    writeFile(dir, 'a.txt', 'before\r\n');
    const lease = await manager.create(dir, signal());
    expect(fs.readFileSync(path.join(lease.cwd, 'a.txt'))).toEqual(Buffer.from('before\r\n'));
    writeFile(lease.cwd, 'a.txt', 'after\r\n'); await manager.integrate(lease, [], signal());
    expect(fs.readFileSync(path.join(dir, 'a.txt'))).toEqual(Buffer.from('after\r\n'));
  });

  it('does not execute repository hooks or fsmonitor commands while preparing a writer', async () => {
    const dir = project(true); const marker = path.join(root, 'hook-ran').replaceAll('\\', '/');
    const command = `#!/bin/sh\nprintf ran >> "${marker}"\n`;
    const hook = writeFile(dir, '.git/hooks/post-checkout', command);
    const monitor = writeFile(dir, '.git/hooks/private-fsmonitor', command);
    fs.chmodSync(hook, 0o755); fs.chmodSync(monitor, 0o755);
    gitSync(dir, 'config', 'core.fsmonitor', monitor);
    await manager.create(dir, signal());
    expect(fs.existsSync(marker)).toBe(false);
  });
});
