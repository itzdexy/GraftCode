import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CatalogSynchronizer } from '../providers/catalogSync';
import type { CatalogSyncStatus } from '@shared/schemas/catalogSync';
import type { EnvironmentInfo } from '@shared/schemas/app';
import { openDatabase, type Db } from '../db/database';
import { ProjectsRepo } from '../db/projectsRepo';
import { ProvidersRepo } from '../db/providersRepo';
import { SessionsRepo } from '../db/sessionsRepo';
import { ChatFiles } from '../chat/chatFiles';
import { CheckpointService } from '../git/checkpoints';
import { DiffStatsCache } from '../git/diffStats';
import { runGit } from '../git/git';
import { SettingsStore } from '../permissions/settingsStore';
import { createProvider, ProviderRegistry } from '../providers/registry';
import { SqliteModelSnapshots } from '../providers/modelSnapshots';
import { dataHandling } from '@shared/privacy';
import type { ProviderSummary } from '@shared/schemas/models';
import { PROVIDER_ENGINES, SearchService, searchReaderModel, type ProviderEngine } from '../tools/web/search';
import { ProviderCatalog } from '../providers/presets';
import { KeyStore, type Encryptor } from '../secrets/keyStore';
import { AppSettingsService } from '../settings/appSettings';
import { createBuiltinRegistry, findRipgrep } from '../tools/builtin';
import type { ToolRegistry } from '../tools/registry';
import { runFile } from '../tools/run';
import { detectShell, type ShellSpec } from '../tools/shell/detect';
import { ShellManager } from '../tools/shell/shellManager';
import { SandboxManager } from '../sandbox/sandbox';
import { SiteServer } from '../sites/siteServer';
import type { ImageProviderKind } from '../media/images';
import { MediaService, type ProviderImageAccess } from '../media/mediaService';
import { starterPage, SitesStore } from '../sites/sites';
import { log } from './log';
import type { GraftPaths } from './paths';
import { LanguageServers } from '../languages/servers';
import { EditorDraftsRepo } from '../db/editorDraftsRepo';

export interface Services {
  paths: GraftPaths;
  db: Db;
  settings: AppSettingsService;
  keys: KeyStore;
  providers: ProvidersRepo;
  registry: ProviderRegistry;
  catalog: ProviderCatalog;
  catalogSync: CatalogSynchronizer;
  languages: LanguageServers;
  editorDrafts: EditorDraftsRepo;
  /** Engine behind the WebSearch tool (Settings → Web search). */
  search: SearchService;
  /** Image models and ComfyUI behind the GenerateImage and ComfyUI tools (Settings → Images). */
  media: MediaService;
  projects: ProjectsRepo;
  sessionsRepo: SessionsRepo;
  checkpoints: CheckpointService;
  chatFiles: ChatFiles;
  diffStats: DiffStatsCache;
  shells: ShellManager;
  shell: ShellSpec;
  /** Containers that run sandboxed projects' commands. */
  sandbox: SandboxManager;
  /** Websites from the Sites tab, and the local server that hosts them (started on first use). */
  sites: SitesStore;
  siteServer: SiteServer;
  tools: ToolRegistry;
  settingsFiles: SettingsStore;
  rgPath: string;
  ghPath: string | null;
  /** VS Code's `code` launcher, used by "Open in editor". */
  codePath: string | null;
  environment: EnvironmentInfo;
}

export type ProgressFn = (step: string, label: string, done: number, total: number) => void;

const READER_TTL_MS = 60 * 60_000;

/**
 * WebSearch engines. Providers search with their own web search through the
 * user's key and their cheapest suitable model; only vendor endpoints count,
 * since a proxy or local server may not offer search. The default model's
 * provider comes first.
 */
function searchService(settings: AppSettingsService, keys: KeyStore, registry: ProviderRegistry): SearchService {
  const readers = new Map<string, { model: string; at: number }>();
  const usable = (): ProviderSummary[] => {
    const preferred = settings.get().defaults.model?.providerId ?? null;
    const list = registry
      .summaries()
      .filter((p) => p.enabled && p.hasKey && (PROVIDER_ENGINES as readonly string[]).includes(p.kind) && dataHandling(p) !== 'unknown' && dataHandling(p) !== 'local');
    return [...list.filter((p) => p.id === preferred), ...list.filter((p) => p.id !== preferred)];
  };
  return new SearchService({
    settings: () => settings.get().search,
    noTraining: () => settings.get().privacy.noTraining,
    keys,
    providers: () => [...new Set(usable().map((p) => p.kind as ProviderEngine))],
    access: async (engine, signal) => {
      const provider = usable().find((p) => p.kind === engine);
      if (!provider) return null;
      let apiKey: string | null;
      try {
        apiKey = keys.get(provider.id);
      } catch {
        apiKey = null;
      }
      if (!apiKey) return null;
      let reader = readers.get(provider.id);
      if (!reader || Date.now() - reader.at > READER_TTL_MS) {
        const model = searchReaderModel(engine, await registry.listModels(provider.id, signal ? { signal } : {}));
        if (!model) return null;
        reader = { model, at: Date.now() };
        readers.set(provider.id, reader);
      }
      return { baseUrl: provider.baseUrl, apiKey, model: reader.model };
    }
  });
}

const IMAGE_PROVIDERS: readonly string[] = ['openrouter', 'openai', 'gemini'] satisfies ImageProviderKind[];

/**
 * Generated media. Providers that make images are the vendors' own endpoints
 * with a key (a custom or local server may not have an images endpoint); the
 * default model's provider comes first, so "auto" spends on the key the user
 * already works with.
 */
function mediaService(settings: AppSettingsService, keys: KeyStore, registry: ProviderRegistry, graftHome: string, thumbnail: MediaThumbnail | undefined): MediaService {
  return new MediaService({
    settings: () => settings.get().media,
    graftHome,
    ...(thumbnail ? { thumbnail } : {}),
    providers: () => {
      const preferred = settings.get().defaults.model?.providerId ?? null;
      const usable = registry.summaries().filter((p) => p.enabled && p.hasKey && IMAGE_PROVIDERS.includes(p.kind));
      return [...usable.filter((p) => p.id === preferred), ...usable.filter((p) => p.id !== preferred)].flatMap((p): ProviderImageAccess[] => {
        let apiKey: string | null;
        try {
          apiKey = keys.get(p.id);
        } catch {
          apiKey = null;
        }
        return apiKey ? [{ kind: p.kind as ImageProviderKind, apiKey, baseUrl: p.baseUrl }] : [];
      });
    }
  });
}

/** Makes a small JPEG of a picture for the transcript (Electron's image code, passed in so this module stays free of Electron). */
export type MediaThumbnail = (data: Buffer) => { mediaType: 'image/jpeg'; data: string } | null;

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
  /** Provider and model catalog shipped with the app (resources/catalog/models.json). */
  catalogFile?: string | null;
  onCatalogChanged?: (status: CatalogSyncStatus) => void;
  /** Previews of generated pictures; absent where images can't be resized. */
  thumbnail?: MediaThumbnail;
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
  const catalog = new ProviderCatalog(options.catalogFile ?? null, (message) => log.warn('providers', message));
  const catalogSync = new CatalogSynchronizer({ file: path.join(paths.userData, 'model-catalog-v1.json'), catalog,
    changed: options.onCatalogChanged, log: (message) => log.warn('catalog', message) });
  const providers = new ProvidersRepo(db);
  const registry = new ProviderRegistry(providers, keys, catalog, createProvider, new SqliteModelSnapshots(db, (message) => log.warn('providers', message)));
  const sandbox = new SandboxManager({ log: (level, message, fields) => log[level]('sandbox', message, fields) });
  const sites = new SitesStore(paths.sites);
  const languages = new LanguageServers();
  const services: Services = {
    paths,
    db,
    settings,
    keys,
    providers,
    registry,
    catalog,
    catalogSync,
    languages,
    search: searchService(settings, keys, registry),
    media: mediaService(settings, keys, registry, paths.graftHome, options.thumbnail),
    projects: new ProjectsRepo(db),
    sessionsRepo: new SessionsRepo(db),
    editorDrafts: new EditorDraftsRepo(db),
    checkpoints: new CheckpointService(db, paths.checkpointsShadow),
    chatFiles: new ChatFiles(paths.chatFiles),
    diffStats: new DiffStatsCache(),
    shells: new ShellManager(shell, paths.shellLogs, process.env, process.platform, sandbox),
    shell,
    sandbox,
    sites,
    siteServer: new SiteServer(
      paths.sites,
      (level, message, fields) => log[level]('sites', message, fields),
      (slug) => {
        const site = sites.get(slug);
        return site ? starterPage(site.name) : null;
      }
    ),
    tools: createBuiltinRegistry(languages),
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
