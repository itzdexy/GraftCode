import fs from 'node:fs';
import os from 'node:os';
import type { EnvironmentInfo } from '@shared/schemas/app';
import { openDatabase, type Db } from '../db/database';
import { ProjectsRepo } from '../db/projectsRepo';
import { ProvidersRepo } from '../db/providersRepo';
import { SessionsRepo } from '../db/sessionsRepo';
import { CheckpointService } from '../git/checkpoints';
import { DiffStatsCache } from '../git/diffStats';
import { runGit } from '../git/git';
import { SettingsStore } from '../permissions/settingsStore';
import { ProviderRegistry } from '../providers/registry';
import { KeyStore, type Encryptor } from '../secrets/keyStore';
import { AppSettingsService } from '../settings/appSettings';
import { createBuiltinRegistry, findRipgrep } from '../tools/builtin';
import type { ToolRegistry } from '../tools/registry';
import { runFile } from '../tools/run';
import { detectShell, type ShellSpec } from '../tools/shell/detect';
import { ShellManager } from '../tools/shell/shellManager';
import { log } from './log';
import type { GraftPaths } from './paths';

export interface Services {
  paths: GraftPaths;
  db: Db;
  settings: AppSettingsService;
  keys: KeyStore;
  providers: ProvidersRepo;
  registry: ProviderRegistry;
  projects: ProjectsRepo;
  sessionsRepo: SessionsRepo;
  checkpoints: CheckpointService;
  diffStats: DiffStatsCache;
  shells: ShellManager;
  shell: ShellSpec;
  tools: ToolRegistry;
  settingsFiles: SettingsStore;
  rgPath: string;
  ghPath: string | null;
  /** VS Code's `code` launcher, used by "Open in editor". */
  codePath: string | null;
  environment: EnvironmentInfo;
}

export type ProgressFn = (step: string, label: string, done: number, total: number) => void;

async function locate(binary: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = await runFile(finder, [binary], { cwd: os.tmpdir(), timeoutMs: 10_000 });
    const first = result.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    return result.code === 0 && first ? first : null;
  } catch (error) {
    log.warn('init', `Could not look up ${binary}`, { message: (error as Error).message });
    return null;
  }
}

/**
 * First-run and startup initialization. Every step does real work and
 * reports progress, which drives the boot screen's progress bar.
 */
export async function initServices(options: {
  paths: GraftPaths;
  encryptor: Encryptor;
  onProgress: ProgressFn;
}): Promise<Services> {
  const { paths, onProgress } = options;
  const total = 6;
  let done = 0;
  const step = (id: string, label: string): void => onProgress(id, label, done++, total);

  step('database', 'Setting up storage');
  fs.mkdirSync(paths.userData, { recursive: true });
  fs.mkdirSync(paths.graftHome, { recursive: true });
  const db = openDatabase(paths.database);

  step('git', 'Checking for git');
  let gitVersion: string | null = null;
  try {
    const version = await runGit(['--version'], { cwd: os.tmpdir(), allowFail: true });
    if (version.code === 0) gitVersion = version.stdout.trim().replace(/^git version\s*/, '');
  } catch (error) {
    log.warn('init', 'Git is unavailable', { message: (error as Error).message });
  }

  step('shell', 'Finding a shell');
  const shell = detectShell(process.platform, process.env);

  step('ripgrep', 'Preparing code search');
  const rgPath = findRipgrep();
  const rg = await runFile(rgPath, ['--version'], { cwd: os.tmpdir(), timeoutMs: 10_000 }).catch((error: unknown) => {
    log.warn('init', 'ripgrep is unavailable', { message: (error as Error).message });
    return null;
  });

  step('keyring', 'Checking the system keyring');
  const keyring = options.encryptor.isEncryptionAvailable();

  step('tools', 'Loading tools');
  const [ghPath, codePath] = await Promise.all([locate('gh'), locate('code')]);
  const settings = new AppSettingsService(db);
  const keys = new KeyStore(db, options.encryptor, () => settings.get().security.allowPlaintextKeys);
  const providers = new ProvidersRepo(db);
  const services: Services = {
    paths,
    db,
    settings,
    keys,
    providers,
    registry: new ProviderRegistry(providers, keys),
    projects: new ProjectsRepo(db),
    sessionsRepo: new SessionsRepo(db),
    checkpoints: new CheckpointService(db, paths.checkpointsShadow),
    diffStats: new DiffStatsCache(),
    shells: new ShellManager(shell, paths.shellLogs),
    shell,
    tools: createBuiltinRegistry(),
    settingsFiles: new SettingsStore(paths.graftHome),
    rgPath,
    ghPath,
    codePath,
    environment: {
      platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux',
      git: { available: gitVersion !== null, version: gitVersion },
      shell: { kind: shell.kind, label: shell.label, path: shell.path },
      ripgrep: rg?.code === 0,
      keyring,
      gh: ghPath !== null
    }
  };
  onProgress('ready', 'Ready', total, total);
  return services;
}
