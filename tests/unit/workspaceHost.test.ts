import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceHost } from '../../src/main/agent/workspaceHost';
import type { WorkspaceLease } from '../../src/main/agent/workspaces';
import type { LoopHost } from '../../src/main/agent/loop';
import { makeToolContext } from '../support/toolContext';
import { makeTempDir, removeDir } from '../support/tmp';

let dir: string;
beforeEach(() => { dir = makeTempDir(); });
afterEach(() => { vi.restoreAllMocks(); removeDir(dir); });
function setup() {
  const project = path.join(dir, 'project'); const checkout = path.join(dir, 'checkout');
  fs.mkdirSync(project); fs.mkdirSync(checkout);
  const context = makeToolContext(project);
  const decide = vi.fn<LoopHost['decide']>(() => ({ behavior: 'allow', reason: 'allowed', dangerous: null, outsideProject: false, suggestedRule: null }));
  const parent: LoopHost = {
    append: () => { throw new Error('unused'); }, emit: () => undefined, decide, askPermission: () => Promise.resolve({ decision: 'deny' }),
    toolContext: () => context, describeContext: () => context, hooks: null, maybeCompact: () => Promise.resolve(null),
    onUsage: () => undefined, todos: () => [], takeSteering: () => Promise.resolve([]), log: () => undefined
  };
  const lease: WorkspaceLease = { id: 'writer', root: checkout, cwd: checkout,
    base: { root: project, gitDir: path.join(project, '.git'), commitSha: 'base', shadow: false, attrSource: true },
    info: { path: checkout, branch: 'graft/agent-writer', baseCommit: 'base', state: 'working', patchPath: null } };
  return { project, checkout, context, parent, lease, decide };
}

describe('writer tool routing', () => {
  it('routes file and shell state into the checkout while checking the original project permission rules', async () => {
    const h = setup(); const wrapped = await workspaceHost(h.parent, h.lease);
    const context = wrapped.host.toolContext('write', new AbortController().signal);
    expect(context.cwd).toBe(h.checkout); expect(context.sessionId).not.toBe(h.context.sessionId);
    expect(context.files).not.toBe(h.context.files);
    wrapped.host.decide({ toolName: 'Write', permissionClass: 'write', descriptor: { summary: 'write', writes: [path.join(h.checkout, 'a.txt')] } });
    expect(h.decide.mock.calls[0]?.[0].descriptor.writes).toEqual([path.join(h.project, 'a.txt')]);
    await wrapped.close();
  });

  it('denies direct writes to the destination, git metadata and links outside the checkout', async () => {
    const h = setup(); const link = path.join(h.checkout, 'outside');
    fs.symlinkSync(h.project, link, process.platform === 'win32' ? 'junction' : 'dir');
    const wrapped = await workspaceHost(h.parent, h.lease);
    for (const file of [path.join(h.project, 'a.txt'), path.join(h.checkout, '.git'), path.join(link, 'a.txt')]) {
      expect(wrapped.host.decide({ toolName: 'Write', permissionClass: 'write', descriptor: { summary: 'write', writes: [file] } }).behavior).toBe('deny');
    }
    expect(h.decide).not.toHaveBeenCalled();
    await wrapped.close();
  });

  it('inherits the parent sandbox with a separate workspace instead of silently running commands on the host', async () => {
    const h = setup();
    const target = { workspace: h.project, settings: { engine: 'docker' as const, image: 'node:24', network: false, memoryMb: 1024, cpus: 1 } };
    vi.spyOn(h.context.shells, 'sandboxFor').mockReturnValue(target);
    const set = vi.spyOn(h.context.shells, 'setSandbox').mockResolvedValue();
    const wrapped = await workspaceHost(h.parent, h.lease);
    expect(set).toHaveBeenCalledWith(expect.stringContaining(':agent:writer'), { ...target, workspace: h.checkout });
    await wrapped.close();
  });
});
