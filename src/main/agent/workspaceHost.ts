import fs from 'node:fs';
import path from 'node:path';
import type { LoopHost } from './loop';
import type { WorkspaceLease } from './workspaces';
import { FileStateTracker } from '../tools/fileState';

function within(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Normal edit tools cannot write through a symlink back into the destination or shared git metadata. */
function privateWrite(root: string, file: string): boolean {
  const abs = path.resolve(file);
  if (!within(root, abs) || path.relative(root, abs).split(path.sep).some((part) => part.toLowerCase() === '.git')) return false;
  let existing = abs;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  const resolved = fs.realpathSync(existing);
  return resolved === root || within(root, resolved);
}

/** Route file tools, hooks and shell state into one lease while retaining the project's permission rules. */
export async function workspaceHost(parent: LoopHost, lease: WorkspaceLease): Promise<{ host: LoopHost; close(): Promise<void> }> {
  const old = parent.describeContext();
  const root = fs.realpathSync(lease.cwd);
  const context = parent.toolContext('workspace-init', new AbortController().signal);
  const sessionId = `${context.sessionId}:agent:${lease.id}`;
  const files = new FileStateTracker(old.platform);
  const target = context.shells.sandboxFor(context.sessionId);
  if (target) await context.shells.setSandbox(sessionId, { ...target, workspace: root });
  context.shells.resetSession(sessionId, root);
  const map = (file: string): string => within(root, file) ? path.join(old.projectRoot, path.relative(root, file)) : file;
  const host: LoopHost = {
    ...parent,
    describeContext: () => ({ ...old, cwd: root, projectRoot: root }),
    hooks: parent.hooks?.inDirectory(root) ?? null,
    decide: (query) => {
      if ((query.descriptor.writes ?? []).some((file) => !privateWrite(root, file))) return {
        behavior: 'deny', reason: 'This writer may change files only in its private checkout, without following links outside it or editing Git metadata.',
        dangerous: null, outsideProject: true, suggestedRule: null
      };
      return parent.decide({ ...query, descriptor: { ...query.descriptor,
        ...(query.descriptor.reads ? { reads: query.descriptor.reads.map(map) } : {}),
        ...(query.descriptor.writes ? { writes: query.descriptor.writes.map(map) } : {}) } });
    },
    toolContext: (id, signal) => {
      const original = parent.toolContext(id, signal);
      return { ...original, cwd: root, projectRoot: root, sessionId, files,
        notesForPaths: (paths) => original.notesForPaths(paths.map(map)) };
    }
  };
  return { host, close: () => context.shells.disposeSession(sessionId) };
}
