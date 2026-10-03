import path from 'node:path';
import type { DataHandling } from '../../src/shared/privacy';
import type { AgentEvent } from '../../src/shared/schemas/agentEvents';
import type { EffortLevel, PermissionMode } from '../../src/shared/schemas/common';
import type { ModelInfo } from '../../src/shared/schemas/models';
import type { SessionSummary } from '../../src/shared/schemas/sessions';
import type { HookEvent } from '../../src/shared/schemas/config';
import { MemorySessionStore } from '../../src/main/db/memorySessionStore';
import { EMPTY_SESSION_USAGE } from '../../src/main/db/sessionsRepo';
import { AgentSession, type SessionDeps, type SessionPreferences } from '../../src/main/agent/session';
import { HookRunner } from '../../src/main/agent/hooks';
import { SettingsStore, type ScopedHook } from '../../src/main/permissions/settingsStore';
import { createBuiltinRegistry } from '../../src/main/tools/builtin';
import { detectShell } from '../../src/main/tools/shell/detect';
import { FakeProvider, fakeModel, type FakeStep } from './fakeProvider';
import { makeTempDir } from './tmp';
import { makeShellManager, RG_PATH } from './toolContext';

export interface Harness {
  session: AgentSession;
  store: MemorySessionStore;
  provider: FakeProvider;
  events: AgentEvent[];
  notifications: Array<{ kind: string; text: string }>;
  titles: string[];
  projectDir: string;
  home: string;
  waitFor(predicate: (e: AgentEvent) => boolean, timeoutMs?: number): Promise<AgentEvent>;
}

export interface HarnessOptions {
  script: FakeStep[];
  mode?: PermissionMode;
  kind?: 'code' | 'chat';
  effort?: EffortLevel | null;
  model?: Partial<ModelInfo>;
  models?: ModelInfo[];
  hooks?: Partial<Record<HookEvent, ScopedHook[]>>;
  autoCompact?: boolean;
  projectDir?: string;
  /** Run the session in this worktree folder of the project. */
  worktreeDir?: string;
  /** Which project folders count as trusted (default: all). */
  trusted?: (root: string) => boolean;
  /** Bypass switched on in Settings. */
  bypassEnabled?: boolean;
  /** Run as an incognito chat (not saved, zero-retention requests). */
  incognito?: boolean;
  /** Settings → Privacy. */
  noTraining?: boolean;
  incognitoLocalOnly?: boolean;
  /** How the fake provider counts for privacy (default: unknown). */
  dataHandling?: DataHandling;
  /** Web search engine (default: none set up). */
  search?: SessionDeps['search'];
  /** Settings: let models search and read the web (default off). */
  webSearch?: boolean;
  /** Computer use switched on with this controller (default off). */
  computer?: SessionDeps['computer'];
  /** Chat file store and code sandbox (default: none). */
  chatFiles?: SessionDeps['chatFiles'];
  runCode?: SessionDeps['runCode'];
  /** Settings → Personalization (default: empty). */
  personalization?: SessionPreferences['personalization'];
  /** Settings → Permissions → Steps per turn (default: no limit). */
  maxSteps?: number | null;
  /** The project's sandbox settings (default: no sandbox). */
  sandbox?: SessionDeps['sandbox'];
  /** A shell manager of the test's own (default: a plain one). */
  shells?: SessionDeps['shells'];
}

export function makeHarness(options: HarnessOptions): Harness {
  const projectDir = options.projectDir ?? makeTempDir();
  const home = makeTempDir('graft home (tmp) ');
  const model = fakeModel(options.model);
  const models = options.models ?? [model];
  const provider = new FakeProvider(options.script, models);
  const store = new MemorySessionStore();
  const summary: SessionSummary = {
    id: 'session-1',
    kind: options.kind ?? 'code',
    title: options.kind === 'chat' ? 'New chat' : 'New session',
    status: 'idle',
    pinned: false,
    archived: false,
    unread: false,
    incognito: options.incognito ?? false,
    projectId: null,
    projectPath: options.kind === 'chat' ? null : projectDir,
    projectName: 'project',
    cwd: options.kind === 'chat' ? null : projectDir,
    worktreePath: options.worktreeDir ?? null,
    branch: null,
    baseBranch: null,
    model: model.ref,
    effort: options.effort === undefined ? 'medium' : options.effort,
    permissionMode: options.mode ?? 'ask',
    lastError: null,
    usage: EMPTY_SESSION_USAGE,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  store.add(summary);
  const events: AgentEvent[] = [];
  const listeners: Array<(e: AgentEvent) => void> = [];
  const notifications: Array<{ kind: string; text: string }> = [];
  const titles: string[] = [];
  const shell = detectShell(process.platform, process.env);
  const settings = new SettingsStore(home);
  const deps: SessionDeps = {
    store,
    retryPolicy: { maxRetries: 2, baseDelayMs: 5, maxDelayMs: 20, maxRetryAfterMs: 20 },
    models: {
      resolve: (ref) => {
        const found = models.find((m) => m.ref.modelId === ref.modelId);
        if (!found) return Promise.reject(new Error(`unknown model ${ref.modelId}`));
        return Promise.resolve({ provider, model: found });
      }
    },
    providerName: () => 'Fake Provider',
    search: options.search ?? { active: () => null, search: () => Promise.reject(new Error('No web search engine in this test.')) },
    computer: options.computer ?? null,
    chatFiles: options.chatFiles ?? null,
    runCode: options.runCode ?? null,
    dataHandling: () => options.dataHandling ?? 'unknown',
    tools: createBuiltinRegistry(),
    mcpToolNames: () => [],
    mcpServerNames: () => [],
    shells: options.shells ?? makeShellManager(path.join(home, 'shell-logs')),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    shellLabel: shell.label,
    settings,
    hooks: () => (options.hooks ? new HookRunner(() => options.hooks ?? {}, shell, () => projectDir) : null),
    rgPath: RG_PATH,
    graftHome: home,
    platform: process.platform,
    isTrusted: options.trusted ?? (() => true),
    trust: () => undefined,
    preferences: () => ({
      webSearch: options.webSearch ?? false,
      bypassEnabled: options.bypassEnabled ?? false,
      bypassKeepsChecks: false,
      autoCompact: options.autoCompact ?? true,
      userName: 'Tester',
      defaultModel: model.ref,
      defaultEffort: 'medium',
      noTraining: options.noTraining ?? false,
      incognitoLocalOnly: options.incognitoLocalOnly ?? false,
      computerUse: options.computer !== undefined,
      personalization: options.personalization ?? { about: '', instructions: '', style: 'default' },
      maxSteps: options.maxSteps ?? null
    }),
    gitInfo: () => Promise.resolve({ isRepo: false, branch: null }),
    checkpoint: () => Promise.resolve(null),
    emit: (_id, event) => {
      events.push(event);
      for (const l of [...listeners]) l(event);
    },
    notify: (_summary, kind, text) => notifications.push({ kind, text }),
    generateTitle: (_summary, text) => titles.push(text),
    log: () => undefined,
    now: () => new Date('2026-09-30T12:00:00Z')
  };
  const session = new AgentSession(summary, deps);
  return {
    session,
    store,
    provider,
    events,
    notifications,
    titles,
    projectDir,
    home,
    waitFor(predicate, timeoutMs = 15_000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs);
        const listener = (e: AgentEvent): void => {
          if (predicate(e)) {
            clearTimeout(timer);
            listeners.splice(listeners.indexOf(listener), 1);
            resolve(e);
          }
        };
        listeners.push(listener);
      });
    }
  };
}
