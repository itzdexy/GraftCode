import os from 'node:os';
import path from 'node:path';

/**
 * Filesystem locations. Tests and E2E runs isolate state with
 * GRAFT_USER_DATA_DIR (Electron userData) and GRAFT_HOME (~/.graft).
 */
export interface GraftPaths {
  /** Electron userData: database, logs, window state, avatar. */
  userData: string;
  /** ~/.graft: worktrees, user GRAFT.md, user commands/skills/settings. */
  graftHome: string;
  logs: string;
  database: string;
  worktrees: string;
  shellLogs: string;
  checkpointsShadow: string;
  /** Files chats made for download, one folder per chat. */
  chatFiles: string;
  /** Websites from the Sites tab, one folder each (Documents/Graft Sites, where people can find them). */
  sites: string;
}

export function resolveGraftHome(): string {
  const override = process.env.GRAFT_HOME;
  return override && override.length > 0 ? path.resolve(override) : path.join(os.homedir(), '.graft');
}

/** Where sites live: GRAFT_SITES_DIR, else beside an isolated GRAFT_HOME (tests), else Documents/Graft Sites. */
function sitesDir(graftHome: string, documents: string): string {
  const override = process.env.GRAFT_SITES_DIR;
  if (override && override.length > 0) return path.resolve(override);
  if (process.env.GRAFT_HOME) return path.join(graftHome, 'sites');
  return path.join(documents, 'Graft Sites');
}

export function buildPaths(userData: string, graftHome: string = resolveGraftHome(), documents: string = path.join(os.homedir(), 'Documents')): GraftPaths {
  return {
    userData,
    graftHome,
    logs: path.join(userData, 'logs'),
    database: path.join(userData, 'graft.db'),
    worktrees: path.join(graftHome, 'worktrees'),
    shellLogs: path.join(userData, 'shell-logs'),
    checkpointsShadow: path.join(userData, 'shadow-repos'),
    chatFiles: path.join(userData, 'chat-files'),
    sites: sitesDir(graftHome, documents)
  };
}
