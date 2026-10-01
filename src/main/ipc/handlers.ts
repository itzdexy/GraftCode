import fs from 'node:fs';
import path from 'node:path';
import { app, dialog, Notification, shell as electronShell, type BrowserWindow } from 'electron';
import { GraftError } from '@shared/errors';
import { fuzzyScore } from '@shared/fuzzy';
import { PROVIDER_KIND_INFO } from '@shared/providerKinds';
import type { GraftEvent } from '@shared/ipc/events';
import type { ProjectSummary, SearchResult } from '@shared/schemas/app';
import type { AppSettings } from '@shared/schemas/appSettings';
import type { VerifyResult } from '@shared/schemas/models';
import type { ProviderKind } from '@shared/schemas/common';
import type { ProjectRecord } from '../db/projectsRepo';
import {
  commit,
  diffForMessage,
  fileDiff,
  listChanges,
  push,
  revertFiles,
  revertHunk,
  stageFiles,
  stageHunk,
  unstageFiles,
  unstageHunk
} from '../git/changes';
import { createPullRequest } from '../git/pr';
import { listBranches, gitInfo } from '../git/repo';
import { generateCommitMessage, titleModel } from '../agent/title';
import { openInEditor } from '../app/editor';
import type { BrowserPanel } from '../browser/browserPanel';
import { listDirectory, readPreview } from '../files/fileTree';
import type { PtyManager } from '../pty/ptyManager';
import { deleteCommand, deleteSkill, listCommands, listMemory, listSkills, saveCommand, saveMemory, saveSkill } from '../customize/customize';
import type { McpManager } from '../mcp/mcpManager';
import { listArtifacts, readArtifactText, isKnownArtifact, type ArtifactServer } from '../artifacts/artifacts';
import { describeCron, nextRun, parseCron } from '../schedule/cron';
import type { Schedule, Scheduler } from '../schedule/scheduler';
import { forgetOAuth } from '../mcp/oauth';
import type { SettingsScope } from '@shared/schemas/config';
import type { McpServerView } from '@shared/schemas/customize';
import { maskConfig, mergeMcpConfig, serverKey } from '../mcp/mcpConfig';
import { ProviderError } from '../providers/errors';
import { normalizeBaseUrl } from '../providers/registry';
import { BUILTIN_COMMANDS, loadCustomCommands } from '../agent/slashCommands';
import type { SessionManager } from '../agent/sessionManager';
import { writeExport } from '../app/dataExport';
import { log } from '../app/log';
import type { UpdateController } from '../app/updater';
import { cleanRuleLists } from '../permissions/rules';
import { isInside } from '../tools/paths';
import { openExternalSafely } from '../app/security';
import type { Services } from '../app/services';
import { FileIndex } from './fileIndex';
import type { HandlerGroup } from './router';

export interface AppContext {
  services(): Promise<Services>;
  sessions(): Promise<SessionManager>;
  ptys(): Promise<PtyManager>;
  mcp(): Promise<McpManager>;
  scheduler(): Promise<Scheduler>;
  artifacts: ArtifactServer;
  /** The Browser panel of the main window (created on first use). */
  browser(): BrowserPanel;
  window(): BrowserWindow | null;
  emit(event: GraftEvent): void;
  updates: UpdateController;
  /** Applies settings that live outside the renderer (tray, updates). */
  settingsChanged(settings: AppSettings): void;
  isFirstLaunch: boolean;
  version: string;
}

/**
 * Name, key requirement and base URL for a provider being added: a catalog
 * preset when one is chosen, else the kind's defaults. Native kinds keep their
 * built-in URL unless the user typed one.
 */
function resolveTarget(
  s: Services,
  kind: ProviderKind,
  presetId: string | null,
  baseUrl: string | null
): { name: string; key: 'required' | 'optional' | 'none'; baseUrl: string | null; urlRequired: boolean } {
  const info = PROVIDER_KIND_INFO[kind];
  const typed = baseUrl?.trim() || null;
  if (presetId) {
    const preset = s.catalog.preset(presetId);
    if (!preset || preset.kind !== kind) throw new GraftError('unknown_preset', `Graft doesn't know the provider "${presetId}".`);
    const fromPreset = kind === 'openai-compatible' || kind === 'ollama' ? preset.baseUrl : null;
    return { name: preset.name, key: preset.key, baseUrl: typed ?? fromPreset, urlRequired: kind === 'openai-compatible' };
  }
  return {
    name: info.name,
    key: info.key,
    baseUrl: typed ?? (info.baseUrl === 'hidden' ? null : info.defaultBaseUrl),
    urlRequired: info.baseUrl === 'required'
  };
}

function projectSummary(p: ProjectRecord): ProjectSummary {
  return {
    id: p.id,
    path: p.path,
    name: p.name,
    trusted: p.trusted,
    exists: fs.existsSync(p.path),
    lastUsedAt: p.lastUsedAt,
    settings: {
      ...(p.settings.model ? { model: p.settings.model } : {}),
      ...(p.settings.effort ? { effort: p.settings.effort } : {}),
      ...(p.settings.permissionMode ? { permissionMode: p.settings.permissionMode } : {}),
      ...(p.settings.useWorktree !== undefined ? { useWorktree: p.settings.useWorktree } : {})
    }
  };
}

function scheduleView(s: Schedule) {
  return { ...s, description: describeCron(s.cron) };
}

function verifyError(error: unknown): VerifyResult {
  if (error instanceof ProviderError) return { ok: false, code: error.code === 'not_found' ? 'bad_base_url' : error.code, message: error.message };
  if (error instanceof GraftError) return { ok: false, code: 'bad_request', message: error.message };
  return { ok: false, code: 'unknown', message: error instanceof Error ? error.message : String(error) };
}

export function buildHandlers(ctx: AppContext): HandlerGroup {
  let fileIndex: FileIndex | null = null;
  const files = async (): Promise<FileIndex> => (fileIndex ??= new FileIndex((await ctx.services()).rgPath));
  const emitProviders = async (): Promise<void> => {
    ctx.emit({ type: 'providers:changed', providers: (await ctx.services()).registry.summaries() });
  };
  /** The folder a session works in (its worktree, else its project folder). */
  const workDirFor = async (sessionId: string): Promise<string> => {
    const summary = (await ctx.sessions()).summary(sessionId);
    const dir = summary.worktreePath ?? summary.cwd;
    if (!dir) throw new GraftError('no_folder', 'This session has no folder.');
    if (!fs.existsSync(dir)) throw new GraftError('folder_missing', `The folder ${dir} no longer exists.`);
    return dir;
  };
  const changed = async (dir: string): Promise<void> => {
    (await ctx.services()).diffStats.invalidate(dir);
  };

  return {
    'app:bootstrap': async () => {
      const s = await ctx.services();
      const settings = s.settings.get();
      return {
        firstRun: settings.onboarding.step !== 'done',
        settings,
        providers: s.registry.summaries(),
        environment: s.environment,
        paths: { userData: s.paths.userData, graftHome: s.paths.graftHome },
        version: ctx.version
      };
    },
    'app:environment': async () => (await ctx.services()).environment,
    'app:openExternal': ({ url }) => openExternalSafely(url),
    'app:revealPath': async ({ path }) => {
      if (!fs.existsSync(path)) throw new GraftError('not_found', `${path} doesn't exist.`);
      if (fs.statSync(path).isDirectory()) {
        const error = await electronShell.openPath(path);
        if (error) throw new GraftError('open_failed', error);
      } else {
        electronShell.showItemInFolder(path);
      }
    },
    'app:quickSplash': () => !ctx.isFirstLaunch,
    'app:log': ({ level, message, stack }) => {
      log[level]('renderer', message, stack ? { stack } : undefined);
    },
    'app:openInEditor': async ({ path }) => ({ via: await openInEditor(path, (await ctx.services()).codePath) }),
    'dialog:pickFolder': async ({ title }) => {
      const win = ctx.window();
      const options = { title: title ?? 'Choose a folder', properties: ['openDirectory' as const, 'createDirectory' as const] };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },

    'settings:get': async () => (await ctx.services()).settings.get(),
    'settings:update': async (patch) => {
      const s = await ctx.services();
      const next = s.settings.update(patch);
      if (patch.behavior?.bypassModeEnabled === false) (await ctx.sessions()).demoteBypass();
      if (patch.security?.allowPlaintextKeys === false) {
        const removed = s.keys.purgePlaintext();
        if (removed > 0) await emitProviders();
      }
      ctx.emit({ type: 'settings:changed', settings: next });
      ctx.settingsChanged(next);
      return next;
    },
    'profile:update': async (profile) => {
      const s = await ctx.services();
      const next = s.settings.update({
        profile: { ...(profile.name !== undefined ? { name: profile.name } : {}), ...(profile.avatar !== undefined ? { avatar: profile.avatar } : {}) }
      });
      ctx.emit({ type: 'settings:changed', settings: next });
      return next;
    },
    'onboarding:complete': async ({ model, effort, projectPath }) => {
      const s = await ctx.services();
      if (!s.registry.summaries().some((p) => p.id === model.providerId)) throw new GraftError('provider_not_found', 'Add a provider first.');
      if (projectPath) {
        if (!fs.existsSync(projectPath)) throw new GraftError('folder_missing', `The folder ${projectPath} doesn't exist.`);
        s.projects.upsert(projectPath);
      }
      const next = s.settings.update({
        onboarding: { step: 'done' },
        defaults: { model, effort, ...(projectPath ? { lastProjectPath: projectPath } : {}) },
        ui: { mode: 'code' }
      });
      ctx.emit({ type: 'settings:changed', settings: next });
      return next;
    },
    'onboarding:reset': async () => {
      const s = await ctx.services();
      const next = s.settings.update({ onboarding: { step: 'name', providerKind: null, providerPreset: null, providerId: null } });
      ctx.emit({ type: 'settings:changed', settings: next });
      return next;
    },

    'providers:list': async () => (await ctx.services()).registry.summaries(),
    'providers:presets': async () => (await ctx.services()).catalog.presets(),
    'providers:verify': async ({ kind, preset, baseUrl, apiKey }) => {
      const s = await ctx.services();
      const target = resolveTarget(s, kind, preset, baseUrl);
      if (target.key === 'required' && !apiKey?.trim()) return { ok: false, code: 'auth', message: 'Paste an API key first.' };
      if (target.urlRequired && !target.baseUrl) return { ok: false, code: 'bad_base_url', message: 'Enter the server\'s base URL.' };
      try {
        return await s.registry.verifyDraft({ kind, preset, baseUrl: target.baseUrl, apiKey: apiKey?.trim() || null }, AbortSignal.timeout(30_000));
      } catch (error) {
        return verifyError(error);
      }
    },
    'providers:add': async ({ kind, preset, label, baseUrl, apiKey }) => {
      const s = await ctx.services();
      const target = resolveTarget(s, kind, preset, baseUrl);
      const key = apiKey?.trim() || null;
      if (target.key === 'required' && !key) throw new GraftError('key_required', `${target.name} needs an API key.`);
      const url = normalizeBaseUrl(target.baseUrl);
      if (target.urlRequired && !url) throw new GraftError('base_url_required', 'Enter the server\'s base URL.');
      const record = s.providers.create({ kind, preset, label: label?.trim() || target.name, baseUrl: url });
      try {
        if (key) s.keys.set(record.id, key);
      } catch (error) {
        s.providers.delete(record.id);
        throw error;
      }
      await emitProviders();
      const summary = s.registry.summaries().find((p) => p.id === record.id);
      if (!summary) throw new GraftError('provider_not_found', 'The provider could not be saved.');
      return summary;
    },
    'providers:update': async ({ id, label, baseUrl, apiKey, enabled, customModels }) => {
      const s = await ctx.services();
      s.providers.update(id, {
        ...(label !== undefined ? { label } : {}),
        ...(baseUrl !== undefined ? { baseUrl: normalizeBaseUrl(baseUrl) } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(customModels !== undefined ? { customModels } : {})
      });
      if (apiKey !== undefined) s.keys.set(id, apiKey.trim());
      s.registry.invalidate(id);
      await emitProviders();
      const summary = s.registry.summaries().find((p) => p.id === id);
      if (!summary) throw new GraftError('provider_not_found', 'That provider no longer exists.');
      return summary;
    },
    'providers:remove': async ({ id }) => {
      const s = await ctx.services();
      s.providers.delete(id);
      s.keys.delete(id);
      s.registry.invalidate(id);
      if (s.settings.get().defaults.model?.providerId === id) {
        ctx.emit({ type: 'settings:changed', settings: s.settings.update({ defaults: { model: null } }) });
      }
      await emitProviders();
      return { ok: true as const };
    },
    'providers:setDefault': async ({ id }) => {
      const s = await ctx.services();
      s.providers.setDefault(id);
      await emitProviders();
      return { ok: true as const };
    },
    'providers:test': async ({ id }) => {
      const s = await ctx.services();
      try {
        const models = await s.registry.listModels(id, { refresh: true, signal: AbortSignal.timeout(30_000) });
        return { ok: true, modelCount: models.length };
      } catch (error) {
        return verifyError(error);
      }
    },
    'models:list': async ({ refresh }) => (await ctx.services()).registry.allModels({ refresh }),
    'secrets:status': async () => (await ctx.services()).keys.status(),

    'projects:list': async () => (await ctx.services()).projects.list().map(projectSummary),
    'projects:add': async ({ path }) => {
      const s = await ctx.services();
      if (!fs.existsSync(path) || !fs.statSync(path).isDirectory()) throw new GraftError('folder_missing', `${path} isn't a folder.`);
      return projectSummary(s.projects.upsert(path));
    },
    'projects:update': async ({ id, name, trusted, settings }) => {
      const s = await ctx.services();
      const current = s.projects.require(id);
      const record = s.projects.update(id, {
        ...(name !== undefined ? { name } : {}),
        ...(trusted !== undefined ? { trusted } : {}),
        ...(settings !== undefined ? { settings: { ...current.settings, ...(settings as ProjectRecord['settings']) } } : {})
      });
      return projectSummary(record);
    },
    'projects:remove': async ({ id }) => {
      const inUse = (await ctx.sessions()).list(true).filter((s) => s.projectId === id).length;
      if (inUse > 0) {
        throw new GraftError('project_in_use', `${inUse} ${inUse === 1 ? 'session uses' : 'sessions use'} this folder. Delete them first, or keep the project.`);
      }
      (await ctx.services()).projects.delete(id);
      return { ok: true as const };
    },
    'git:branches': async ({ path }) => {
      const info = await gitInfo(path);
      if (!info.isRepo) return { isRepo: false, current: null, branches: [] };
      return { isRepo: true, current: info.branch, branches: await listBranches(path) };
    },
    'git:diffStats': async ({ sessionId }) => {
      const s = await ctx.services();
      const summary = (await ctx.sessions()).summary(sessionId);
      const dir = summary.worktreePath ?? summary.cwd;
      if (!dir) return { added: 0, removed: 0, files: 0, base: null, branch: null };
      return s.diffStats.get(dir);
    },
    'git:status': async ({ sessionId }) => {
      const dir = await workDirFor(sessionId);
      const info = await gitInfo(dir);
      if (!info.isRepo) return { isRepo: false, workDir: dir, branch: null, files: [] };
      return { isRepo: true, workDir: dir, branch: info.branch, files: await listChanges(dir) };
    },
    'git:fileDiff': async ({ sessionId, path, staged }) => fileDiff(await workDirFor(sessionId), path, staged),
    'git:stage': async ({ sessionId, paths }) => {
      const dir = await workDirFor(sessionId);
      await stageFiles(dir, paths);
      await changed(dir);
      return { ok: true as const };
    },
    'git:unstage': async ({ sessionId, paths }) => {
      const dir = await workDirFor(sessionId);
      await unstageFiles(dir, paths);
      await changed(dir);
      return { ok: true as const };
    },
    'git:revert': async ({ sessionId, paths }) => {
      const dir = await workDirFor(sessionId);
      await revertFiles(dir, paths);
      await changed(dir);
      return { ok: true as const };
    },
    'git:hunk': async ({ sessionId, path, index, action }) => {
      const dir = await workDirFor(sessionId);
      if (action === 'stage') await stageHunk(dir, path, index);
      else if (action === 'unstage') await unstageHunk(dir, path, index);
      else await revertHunk(dir, path, index);
      await changed(dir);
      return { ok: true as const };
    },
    'git:commit': async ({ sessionId, message, stageAll }) => {
      const dir = await workDirFor(sessionId);
      const sha = await commit(dir, message, { stageAll });
      await changed(dir);
      return { sha };
    },
    'git:push': async ({ sessionId }) => push(await workDirFor(sessionId)),
    'git:createPr': async ({ sessionId }) => {
      const dir = await workDirFor(sessionId);
      return createPullRequest(dir, { ghPath: (await ctx.services()).ghPath });
    },
    'git:suggestCommitMessage': async ({ sessionId }) => {
      const s = await ctx.services();
      const dir = await workDirFor(sessionId);
      const ref = (await ctx.sessions()).summary(sessionId).model ?? s.settings.get().defaults.model;
      if (!ref) throw new GraftError('no_model', 'Choose a model for this session first.');
      const models = await s.registry.listModels(ref.providerId);
      const current = models.find((m) => m.ref.modelId === ref.modelId);
      if (!current) throw new GraftError('model_not_found', `The model ${ref.modelId} is no longer available.`);
      const diff = await diffForMessage(dir);
      if (diff.trim().length === 0) throw new GraftError('nothing_to_commit', 'There are no changes to describe.');
      const message = await generateCommitMessage(s.registry.get(ref.providerId), titleModel(current, models), diff, AbortSignal.timeout(60_000));
      if (!message) throw new GraftError('suggest_failed', 'The model returned an empty commit message. Write one yourself or try again.');
      return { message };
    },

    'sessions:list': async ({ includeArchived }) => (await ctx.sessions()).list(includeArchived),
    'sessions:create': async (input) => (await ctx.sessions()).create(input),
    'sessions:get': async ({ id }) => (await ctx.sessions()).detail(id),
    'sessions:send': async ({ id, text, images, files }) => (await ctx.sessions()).send(id, text, images, files),
    'sessions:interrupt': async ({ id }) => {
      (await ctx.sessions()).interrupt(id);
      return { ok: true as const };
    },
    'sessions:respondPermission': async ({ sessionId, ...response }) => {
      (await ctx.sessions()).respondPermission(sessionId, response);
      return { ok: true as const };
    },
    'sessions:answerQuestion': async ({ sessionId, ...response }) => {
      (await ctx.sessions()).answerQuestion(sessionId, response);
      return { ok: true as const };
    },
    'sessions:setMode': async ({ id, mode }) => {
      (await ctx.sessions()).setMode(id, mode);
      return { ok: true as const };
    },
    'sessions:cycleMode': async ({ id }) => (await ctx.sessions()).cycleMode(id),
    'sessions:setModel': async ({ id, model, effort }) => {
      (await ctx.sessions()).setModel(id, model, effort);
      return { ok: true as const };
    },
    'sessions:rename': async ({ id, title }) => {
      (await ctx.sessions()).rename(id, title);
      return { ok: true as const };
    },
    'sessions:setPinned': async ({ id, pinned }) => {
      (await ctx.sessions()).setPinned(id, pinned);
      return { ok: true as const };
    },
    'sessions:archive': async ({ id, archived, removeWorktree, force }) => {
      const result = await (await ctx.sessions()).archive(id, archived, removeWorktree, force);
      if (archived) await (await ctx.ptys()).disposeSession(id);
      return result;
    },
    'sessions:delete': async ({ id, force }) => {
      await (await ctx.sessions()).remove(id, force);
      await (await ctx.ptys()).disposeSession(id);
      return { ok: true as const };
    },
    'sessions:duplicate': async ({ id }) => (await ctx.sessions()).duplicate(id),
    'sessions:export': async ({ id, format }) => {
      const manager = await ctx.sessions();
      const summary = manager.summary(id);
      const win = ctx.window();
      const ext = format === 'json' ? 'json' : 'md';
      const safe = summary.title.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'session';
      const options = { title: 'Export session', defaultPath: `${safe}.${ext}`, filters: [{ name: format === 'json' ? 'JSON' : 'Markdown', extensions: [ext] }] };
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      fs.writeFileSync(result.filePath, manager.exportText(id, format), 'utf8');
      return result.filePath;
    },
    'sessions:retry': async ({ id }) => {
      (await ctx.sessions()).retry(id);
      return { ok: true as const };
    },
    'sessions:regenerate': async ({ id }) => {
      (await ctx.sessions()).regenerate(id);
      return { ok: true as const };
    },
    'sessions:compact': async ({ id, instructions }) => {
      (await ctx.sessions()).compact(id, instructions);
      return { ok: true as const };
    },
    'sessions:removeQueued': async ({ id, queueId }) => {
      (await ctx.sessions()).removeQueued(id, queueId);
      return { ok: true as const };
    },
    'sessions:markRead': async ({ id }) => {
      (await ctx.sessions()).markRead(id);
      return { ok: true as const };
    },
    'sessions:setActive': async ({ id }) => {
      (await ctx.sessions()).setActive(id);
      return { ok: true as const };
    },
    'sessions:feedback': async ({ sessionId, messageId, value }) => {
      (await ctx.sessions()).feedback(sessionId, messageId, value);
      return { ok: true as const };
    },
    'sessions:rewindPreview': async ({ sessionId, messageId }) => (await ctx.sessions()).rewindPreview(sessionId, messageId),
    'sessions:rewind': async ({ sessionId, messageId, mode }) => (await ctx.sessions()).rewind(sessionId, messageId, mode),

    'search:query': async ({ query, kind }) => {
      const s = await ctx.services();
      const manager = await ctx.sessions();
      const all = manager.list(true).filter((x) => kind === null || x.kind === kind);
      const byId = new Map(all.map((x) => [x.id, x]));
      const results = new Map<string, SearchResult & { score: number }>();
      for (const hit of s.sessionsRepo.search(query, 40)) {
        const summary = byId.get(hit.sessionId);
        if (!summary) continue;
        results.set(hit.sessionId, {
          sessionId: hit.sessionId,
          title: summary.title,
          kind: summary.kind,
          projectName: summary.projectName,
          snippet: hit.messageId ? hit.snippet : '',
          updatedAt: summary.updatedAt,
          score: 100
        });
      }
      for (const summary of all) {
        const score = fuzzyScore(query, summary.title);
        if (score === null || results.has(summary.id)) continue;
        results.set(summary.id, { sessionId: summary.id, title: summary.title, kind: summary.kind, projectName: summary.projectName, snippet: '', updatedAt: summary.updatedAt, score });
      }
      return [...results.values()]
        .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
        .slice(0, 40)
        .map(({ score: _score, ...rest }) => rest);
    },
    'commands:list': async ({ projectPath }) => {
      const s = await ctx.services();
      return [...BUILTIN_COMMANDS, ...loadCustomCommands(s.paths.graftHome, projectPath)].map(({ name, description, argumentHint, source, path }) => ({
        name,
        description,
        argumentHint,
        source,
        path
      }));
    },
    'files:search': async ({ root, query }) => {
      if (!fs.existsSync(root)) return [];
      // Only folders Graft works in: a known project or one of its worktrees.
      const s = await ctx.services();
      const known = s.projects.list().some((p) => isInside(p.path, root)) || isInside(s.paths.worktrees, root);
      if (!known) throw new GraftError('unknown_folder', 'File search works in project folders only.');
      return (await files()).search(root, query, 40);
    },

    'files:list': async ({ sessionId, dir }) => listDirectory(await workDirFor(sessionId), dir),
    'files:read': async ({ sessionId, path }) => readPreview(await workDirFor(sessionId), path),
    'pty:create': async ({ sessionId, cols, rows }) => (await ctx.ptys()).create(sessionId, await workDirFor(sessionId), cols, rows),
    'pty:list': async ({ sessionId }) => (await ctx.ptys()).list(sessionId),
    'pty:snapshot': async ({ id }) => (await ctx.ptys()).snapshot(id),
    'pty:write': async ({ id, data }) => {
      (await ctx.ptys()).write(id, data);
    },
    'pty:resize': async ({ id, cols, rows }) => {
      (await ctx.ptys()).resize(id, cols, rows);
    },
    'pty:kill': async ({ id }) => {
      await (await ctx.ptys()).kill(id);
      return { ok: true as const };
    },
    'shells:list': async ({ sessionId }) => (await ctx.services()).shells.list(sessionId),
    'shells:output': async ({ id }) => {
      const read = (await ctx.services()).shells.readOutput(id);
      if (!read) throw new GraftError('not_found', 'That background command is no longer available.');
      return { output: read.output, skipped: read.skipped };
    },
    'shells:kill': async ({ id }) => ({ killed: await (await ctx.services()).shells.kill(id) }),
    'shells:clear': async ({ sessionId }) => ({ removed: (await ctx.services()).shells.clearFinished(sessionId) }),
    'browser:navigate': async ({ url }) => ({ url: await ctx.browser().navigate(url) }),
    'browser:bounds': ({ bounds }) => {
      ctx.browser().setBounds(bounds);
    },
    'customize:commands': async ({ projectPath }) => listCommands((await ctx.services()).paths.graftHome, projectPath),
    'customize:saveCommand': async ({ scope, projectPath, name, description, argumentHint, body, previousPath }) => ({
      path: await saveCommand((await ctx.services()).paths.graftHome, { scope, projectRoot: projectPath, name, description, argumentHint, body, previousPath })
    }),
    'customize:deleteCommand': async ({ projectPath, path }) => {
      await deleteCommand((await ctx.services()).paths.graftHome, projectPath, path);
      return { ok: true as const };
    },
    'customize:skills': async ({ projectPath }) => listSkills((await ctx.services()).paths.graftHome, projectPath),
    'customize:saveSkill': async ({ scope, projectPath, name, description, body, previousPath }) => ({
      path: await saveSkill((await ctx.services()).paths.graftHome, { scope, projectRoot: projectPath, name, description, body, previousPath })
    }),
    'customize:deleteSkill': async ({ projectPath, path }) => {
      await deleteSkill((await ctx.services()).paths.graftHome, projectPath, path);
      return { ok: true as const };
    },
    'customize:memory': async ({ projectPath }) => listMemory((await ctx.services()).paths.graftHome, projectPath),
    'customize:saveMemory': async ({ scope, projectPath, content }) => ({ path: await saveMemory((await ctx.services()).paths.graftHome, scope, projectPath, content) }),
    'customize:hooks': async ({ projectPath }) => {
      const s = await ctx.services();
      const scopes: SettingsScope[] = projectPath ? ['user', 'project', 'local'] : ['user'];
      return scopes.map((scope) => {
        const loaded = s.settingsFiles.load(scope, projectPath ?? undefined);
        return { scope, path: loaded.path, error: loaded.error, hooks: loaded.settings.hooks ?? {} };
      });
    },
    'customize:saveHooks': async ({ scope, projectPath, hooks }) => {
      await (await ctx.services()).settingsFiles.update(scope, projectPath ?? undefined, (settings) => ({ ...settings, hooks }));
      return { ok: true as const };
    },
    'mcp:list': async ({ projectPath }) => {
      const s = await ctx.services();
      const live = new Map((await ctx.mcp()).status().map((st) => [st.name, st]));
      const trusted = projectPath ? (s.projects.findByPath(projectPath)?.trusted ?? false) : true;
      const scopes: SettingsScope[] = projectPath ? ['user', 'project', 'local'] : ['user'];
      const views: McpServerView[] = [];
      for (const scope of scopes) {
        const loaded = s.settingsFiles.load(scope, projectPath ?? undefined);
        for (const [name, config] of Object.entries(loaded.settings.mcpServers ?? {})) {
          const st = live.get(name);
          const matches = st !== undefined && st.scope === scope && st.projectRoot === (scope === 'user' ? null : projectPath);
          const state: McpServerView['state'] = !config.enabled
            ? 'disabled'
            : matches
              ? st.state
              : scope !== 'user' && !trusted
                ? 'untrusted'
                : 'idle';
          views.push({
            name,
            scope,
            path: loaded.path,
            config: maskConfig(config),
            state,
            error: matches ? st.error : null,
            tools: matches ? st.tools.map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly })) : []
          });
        }
      }
      return views;
    },
    'mcp:save': async ({ scope, projectPath, name, previousName, config }) => {
      const s = await ctx.services();
      await s.settingsFiles.update(scope, projectPath ?? undefined, (settings) => {
        const servers = { ...(settings.mcpServers ?? {}) };
        const previous = servers[previousName ?? name];
        if (previousName && previousName !== name) {
          if (servers[name]) throw new GraftError('mcp_exists', `A server named ${name} already exists in this scope.`);
          delete servers[previousName];
        }
        servers[name] = mergeMcpConfig(config, previous);
        return { ...settings, mcpServers: servers };
      });
      const manager = await ctx.mcp();
      if (projectPath && scope !== 'user') await manager.useProject(projectPath, s.projects.findByPath(projectPath)?.trusted ?? false);
      await manager.sync();
      return { ok: true as const };
    },
    'mcp:remove': async ({ scope, projectPath, name }) => {
      const s = await ctx.services();
      await s.settingsFiles.update(scope, projectPath ?? undefined, (settings) => {
        const servers = { ...(settings.mcpServers ?? {}) };
        delete servers[name];
        return { ...settings, mcpServers: servers };
      });
      forgetOAuth(s.keys, serverKey(scope, scope === 'user' ? null : projectPath, name));
      await (await ctx.mcp()).sync();
      return { ok: true as const };
    },
    'mcp:setEnabled': async ({ scope, projectPath, name, enabled }) => {
      await (await ctx.services()).settingsFiles.update(scope, projectPath ?? undefined, (settings) => {
        const servers = { ...(settings.mcpServers ?? {}) };
        const current = servers[name];
        if (!current) throw new GraftError('mcp_unknown', `No MCP server named ${name} in this scope.`);
        servers[name] = { ...current, enabled };
        return { ...settings, mcpServers: servers };
      });
      await (await ctx.mcp()).sync();
      return { ok: true as const };
    },
    'mcp:reconnect': async ({ name }) => {
      await (await ctx.mcp()).reconnect(name);
      return { ok: true as const };
    },
    'mcp:authorize': async ({ name }) => {
      await (await ctx.mcp()).authorize(name);
      return { ok: true as const };
    },
    'artifacts:list': async () => listArtifacts((await ctx.services()).db),
    'artifacts:read': async ({ path }) => readArtifactText((await ctx.services()).db, path),
    'artifacts:previewUrl': async ({ path }) => {
      if (!isKnownArtifact((await ctx.services()).db, path)) throw new GraftError('not_an_artifact', 'That file is not an artifact from your sessions.');
      return { url: ctx.artifacts.urlFor(path) };
    },
    'permissions:get': async ({ projectPath }) => {
      const s = await ctx.services();
      const scopes: SettingsScope[] = projectPath ? ['user', 'project', 'local'] : ['user'];
      return scopes.map((scope) => {
        const loaded = s.settingsFiles.load(scope, projectPath ?? undefined);
        const p = loaded.settings.permissions;
        return { scope, path: loaded.path, error: loaded.error, allow: p?.allow ?? [], ask: p?.ask ?? [], deny: p?.deny ?? [], defaultMode: p?.defaultMode ?? null };
      });
    },
    'permissions:save': async ({ scope, projectPath, rules }) => {
      if (scope !== 'user' && !projectPath) throw new GraftError('project_required', 'Choose a project for project rules.');
      const { lists: next, invalid } = cleanRuleLists(rules, scope);
      if (invalid.length > 0) {
        throw new GraftError(
          'invalid_rule',
          `${invalid.slice(0, 3).map((r) => `"${r}"`).join(', ')} ${invalid.length === 1 ? 'is not a valid rule' : 'are not valid rules'}. Use Tool or Tool(pattern), for example Shell(npm test:*) or Edit(src/**).`
        );
      }
      await (await ctx.services()).settingsFiles.update(scope, projectPath ?? undefined, (settings) => ({
        ...settings,
        permissions: { ...(settings.permissions ?? {}), ...next }
      }));
      return { ok: true as const };
    },
    'notifications:test': () => {
      if (!Notification.isSupported()) return { shown: false };
      new Notification({ title: 'Graft', body: 'Notifications are on. Sessions that need you or finish in the background show up like this.' }).show();
      return { shown: true };
    },
    'data:export': async () => {
      const s = await ctx.services();
      const win = ctx.window();
      const options = {
        title: 'Export Graft data',
        defaultPath: path.join(app.getPath('documents'), `graft-export-${new Date().toISOString().slice(0, 10)}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      };
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      const scheduler = await ctx.scheduler();
      const sessions = await writeExport(result.filePath, {
        version: ctx.version,
        settings: s.settings.get(),
        providers: s.registry.summaries().map(({ id, kind, label, baseUrl, enabled, isDefault, customModels }) => ({ id, kind, label, baseUrl, enabled, isDefault, customModels })),
        projects: s.projects.list().map(projectSummary),
        schedules: scheduler.list(),
        sessions: () => s.sessionsRepo.list({ includeArchived: true }),
        messages: (id) => s.sessionsRepo.listMessages(id)
      });
      log.info('data', 'Exported data', { sessions: String(sessions) });
      return { path: result.filePath, sessions };
    },
    'data:clearHistory': async () => {
      const { removed, worktreesKept } = await (await ctx.sessions()).clearHistory();
      const ptys = await ctx.ptys();
      for (const id of removed) await ptys.disposeSession(id);
      log.info('data', 'Cleared session history', { removed: String(removed.length), worktreesKept: String(worktreesKept) });
      return { removed: removed.length, worktreesKept };
    },
    'data:openFolder': async () => {
      const failure = await electronShell.openPath((await ctx.services()).paths.userData);
      if (failure) throw new GraftError('open_failed', `Couldn't open the data folder: ${failure}`);
    },
    'updates:state': () => ctx.updates.get(),
    'updates:check': () => ctx.updates.check(),
    'updates:install': () => {
      ctx.updates.install();
      return { ok: true as const };
    },
    'schedules:list': async () => (await ctx.scheduler()).list().map(scheduleView),
    'schedules:save': async ({ id, schedule }) => {
      const scheduler = await ctx.scheduler();
      return scheduleView(id ? scheduler.update(id, schedule) : scheduler.create(schedule));
    },
    'schedules:setEnabled': async ({ id, enabled }) => scheduleView((await ctx.scheduler()).setEnabled(id, enabled)),
    'schedules:delete': async ({ id }) => {
      (await ctx.scheduler()).remove(id);
      return { ok: true as const };
    },
    'schedules:runNow': async ({ id }) => (await ctx.scheduler()).run(id),
    'schedules:runs': async ({ id }) => (await ctx.scheduler()).runs(id),
    'schedules:describe': ({ cron }) => {
      try {
        const next = nextRun(parseCron(cron), new Date());
        return { description: describeCron(cron), next: next?.getTime() ?? null, error: next ? null : 'That schedule never runs.' };
      } catch (error) {
        return { description: cron, next: null, error: (error as Error).message };
      }
    },
    'browser:command': async ({ command }) => {
      const panel = ctx.browser();
      if (command === 'back') panel.back();
      else if (command === 'forward') panel.forward();
      else if (command === 'reload') panel.reload();
      else if (command === 'stop') panel.stop();
      else if (command === 'close') panel.close();
      else {
        const url = panel.currentUrl();
        if (url) await openExternalSafely(url);
      }
    }
  };
}
