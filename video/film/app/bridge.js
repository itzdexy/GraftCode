// Stand-in for the preload bridge while the film is shot: canned main-process answers, so the
// built renderer runs in a plain browser. Sessions get their turns from turns.js.
// Model and provider names are real entries of resources/catalog/models.json.
(function () {
  const now = Date.now();
  const MIN = 60_000;
  const HOME = 'C:/Users/robin';
  const PROJECT = `${HOME}/code/acme-api`;

  const provider = (id, kind, label, isDefault) => ({ id, kind, preset: id, label, baseUrl: null, hasKey: kind !== 'ollama', enabled: true, isDefault: isDefault === true, createdAt: 0, customModels: [] });
  const providers = [provider('anthropic', 'anthropic', 'Anthropic', true), provider('openai', 'openai', 'OpenAI'), provider('google', 'gemini', 'Google'), provider('deepseek', 'openai-compatible', 'DeepSeek'), provider('ollama', 'ollama', 'Ollama')];

  // Every provider Graft can reach, built from the catalog file the way the main process does
  // (src/main/providers/presets.ts), so the picker lists exactly what the app ships with.
  const OLLAMA = { id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', key: 'none', docUrl: 'https://ollama.com', envVars: [], modelCount: 0, local: true };
  const isLocal = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(url);
  let presets = null;
  function loadPresets() {
    presets ??= fetch('/catalog/models.json')
      .then((response) => response.json())
      .then((catalog) =>
        catalog.providers
          .map((p) => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.api, key: p.key, docUrl: p.doc, envVars: p.env, modelCount: p.models.length, local: p.api !== null && isLocal(p.api) }))
          .concat([OLLAMA])
          .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
      );
    return presets;
  }

  const effort = { levels: ['low', 'medium', 'high', 'max', 'taproot'], recommended: 'medium', default: 'medium', values: { low: 'low', medium: 'medium', high: 'high', max: 'max', taproot: 'max' } };
  const model = (providerId, modelId, label, family, featured, pricing) => ({
    ref: { providerId, modelId },
    label,
    description: '',
    family,
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    supportsTools: true,
    supportsVision: true,
    supportsWebSearch: false,
    effort,
    featured,
    cheap: false,
    createdAt: null,
    pricing
  });
  const models = [
    model('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 'claude-sonnet', true, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }),
    model('anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', 'claude-fable', true, { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }),
    model('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', 'claude-haiku', false, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }),
    model('openai', 'gpt-5.5-pro', 'GPT-5.5 Pro', 'gpt-pro', true, null),
    model('openai', 'gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', 'gpt-codex', false, null),
    model('google', 'gemini-3.8-flash', 'Gemini 3.8 Flash', 'gemini-flash', true, null),
    model('google', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', 'gemini-flash-lite', false, null),
    model('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', 'deepseek-pro', true, null),
    model('deepseek', 'deepseek-flash', 'DeepSeek V4.1 Flash', 'deepseek-flash', false, null),
    model('ollama', 'qwen3-coder:30b', 'Qwen3 Coder 30B', 'qwen-coder', true, null),
    model('ollama', 'gpt-oss:20b', 'GPT OSS 20B', 'gpt-oss', false, null)
  ];
  const sessionModel = models[0].ref;

  const settings = {
    profile: { name: 'Robin', avatar: null },
    onboarding: { step: 'done', providerKind: null, providerPreset: null, providerId: 'anthropic' },
    appearance: { theme: 'dark', palette: 'graft', accent: 'leaf', uiFontSize: 13, codeFontSize: 13, motion: 'on', transcriptWidth: 'narrow' },
    personalization: { about: '', instructions: '', style: 'default' },
    defaults: { model: sessionModel, effort: 'medium', permissionMode: 'auto', useWorktree: false, lastProjectPath: PROJECT },
    notifications: { enabled: true, needsInput: true, finished: true, errors: true },
    behavior: { runInTray: false, bypassModeEnabled: false, bypassKeepsChecks: false, autoCompact: true, webSearch: true },
    security: { allowPlaintextKeys: false },
    privacy: { noTraining: true, incognitoLocalOnly: false },
    updates: { enabled: false },
    search: { engine: 'auto', searxngUrl: null },
    voice: { engine: 'natural', model: 'hexgrad/kokoro-82m', voice: 'af_heart', systemVoice: null, speed: 1 },
    agents: { routing: 'auto', roles: { planner: null, coder: null, reviewer: null, security: null, browser: null, vision: null, research: null, fast: null }, maxParallel: 4, tokenBudget: null, retries: 1 },
    media: { imageEngine: 'auto', imageModel: '', comfyEnabled: false, comfyUrl: 'http://127.0.0.1:8188', comfyCheckpoint: '' },
    shortcuts: {
      newSession: 'Ctrl+N',
      search: 'Ctrl+K',
      toggleSidebar: 'Ctrl+B',
      toggleTerminal: 'Ctrl+`',
      toggleChanges: 'Ctrl+Shift+D',
      focusComposer: 'Ctrl+L',
      interrupt: 'Escape',
      cyclePermissionMode: 'Shift+Tab',
      openSettings: 'Ctrl+,',
      toggleFiles: 'Ctrl+Shift+F',
      commandPalette: 'Ctrl+Shift+P'
    },
    // The home tips are dismissed: they are not what any shot is about.
    ui: { sidebarWidth: 262, sidebarCollapsed: false, mode: 'code', dismissedTips: ['code-worktree', 'code-init', 'code-cycle-mode', 'code-search'] }
  };

  function summary(id, title, extra) {
    return Object.assign(
      {
        id,
        kind: 'code',
        title,
        status: 'idle',
        pinned: false,
        archived: false,
        unread: false,
        incognito: false,
        projectId: 'p1',
        projectPath: PROJECT,
        projectName: 'acme-api',
        cwd: PROJECT,
        worktreePath: null,
        branch: 'main',
        baseBranch: 'main',
        model: sessionModel,
        effort: 'medium',
        permissionMode: 'auto',
        lastError: null,
        usage: { totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: 0, contextLimit: 1000000, costUsd: 0 },
        createdAt: now - 30 * MIN,
        updatedAt: now - 2 * MIN
      },
      extra || {}
    );
  }

  // Earlier work in the project, so the sidebar and the home list look lived in.
  const sessions = [
    summary('s-orders', 'Paginate the orders endpoint', { updatedAt: now - 42 * MIN }),
    summary('s-node', 'Upgrade to Node 24', { updatedAt: now - 26 * 60 * MIN }),
    summary('s-flaky', 'Flaky checkout test', { updatedAt: now - 3 * 24 * 60 * MIN })
  ];
  const details = {};

  function detail(id) {
    const s = sessions.find((x) => x.id === id) || sessions[0];
    const d = details[id] || {};
    const turns = window.__turns;
    return { summary: s, messages: d.messages || [], todos: d.todos || [], pendingPermission: turns.pendingPermission(id), pendingQuestion: null, queue: [], agentRuns: turns.agentRuns(id), mission: null };
  }

  const listeners = new Set();
  const emit = (payload) => listeners.forEach((listener) => listener(payload));
  window.__graftEmit = emit;

  const handlers = {
    'app:quickSplash': () => true,
    'app:bootstrap': () => ({
      firstRun: false,
      settings,
      providers,
      environment: {
        platform: 'win32',
        git: { available: true, version: '2.47.0' },
        shell: { kind: 'bash', label: 'Git Bash', path: 'C:/Program Files/Git/bin/bash.exe' },
        ripgrep: true,
        keyring: true,
        gh: true
      },
      paths: { userData: `${HOME}/AppData/Roaming/Graft`, graftHome: `${HOME}/.graft` },
      version: '0.6.7'
    }),
    'app:info': () => ({ name: 'Graft', version: '0.6.7', platform: 'win32', isPackaged: true, versions: { electron: '44.5.1', chrome: '152.0.7977.130', node: '24.21.0' }, dataDir: `${HOME}/AppData/Roaming/Graft` }),
    'app:openExternal': () => null,
    'app:revealPath': () => null,
    'app:openInEditor': () => null,
    'providers:presets': () => loadPresets(),
    'providers:list': () => providers,
    'models:list': () => providers.map((p) => ({ providerId: p.id, models: models.filter((m) => m.ref.providerId === p.id), error: null })),
    'projects:list': () => [{ id: 'p1', path: PROJECT, name: 'acme-api', trusted: true, exists: true, lastUsedAt: now, settings: {} }],
    'commands:list': () => [],
    'updates:state': () => ({ status: 'idle', version: null, progress: null, message: null, checkedAt: null }),
    'updates:check': () => ({ status: 'none', version: null, progress: null, message: null, checkedAt: Date.now() }),
    'secrets:status': () => ({ encryptionAvailable: true, plaintextAllowed: false }),
    'power:keepAwakeList': () => [],
    'schedules:list': () => [],
    'artifacts:list': () => [],
    'sites:list': () => [],
    'mcp:list': () => [],
    'shells:list': () => [],
    'pty:list': () => [],
    'files:index': () => [],
    'files:list': () => [],
    'web:favicon': () => null,
    'integrations:status': () => [],
    'checks:get': () => ({ files: [], suggestions: ['npm run lint', 'npm test'], trusted: true }),
    'media:status': () => ({ engine: null, providers: [], defaults: {}, comfy: null }),
    'search:status': () => ({ active: 'exa', keys: { brave: false, tavily: false }, providers: { openrouter: false, anthropic: true, openai: true, gemini: true } }),
    'window:setTitlebarTheme': () => null,
    'git:status': () => ({ isRepo: true, workDir: PROJECT, branch: 'main', files: [] }),
    'git:diffStats': (input) => window.__turns.diffStats(input.sessionId),
    'git:branches': () => ({ current: 'main', branches: ['main'] }),
    'settings:update': (patch) => {
      for (const [section, value] of Object.entries(patch || {})) Object.assign(settings[section], value);
      return JSON.parse(JSON.stringify(settings));
    },

    'sessions:list': () => sessions,
    'sessions:get': (input) => detail(input.id),
    'sessions:setActive': () => null,
    'sessions:markRead': () => ({ ok: true }),
    'sessions:feedback': () => ({ ok: true }),
    'sessions:setModel': () => ({ ok: true }),
    'sessions:steer': () => ({ ok: true }),
    'sessions:removeQueued': () => ({ ok: true }),
    'sessions:systemPrompt': () => ({ system: '', tools: [], model: 'Claude Sonnet 5.5 via Anthropic' }),
    'sessions:create': (input) => {
      const s = summary(`s-${String(sessions.length + 1)}`, 'New session', { permissionMode: input.permissionMode || settings.defaults.permissionMode, createdAt: Date.now(), updatedAt: Date.now() });
      sessions.push(s);
      setTimeout(() => window.__turns.send(s.id, input.message.text), 30);
      return s;
    },
    'sessions:send': (input) => window.__turns.send(input.id, input.text),
    'sessions:interrupt': (input) => (window.__turns.interrupt(input.id), { ok: true }),
    'sessions:respondPermission': (input) => (window.__turns.decide(input.requestId, input.decision), { ok: true }),
    'sessions:stopAgent': () => ({ stopped: false }),
    'sessions:setMode': (input) => {
      const s = sessions.find((x) => x.id === input.id);
      if (s) s.permissionMode = input.mode;
      emit({ type: 'session:event', sessionId: input.id, event: { type: 'mode', permissionMode: input.mode } });
      return { ok: true };
    },
    'sessions:cycleMode': (input) => {
      const order = ['ask', 'auto-edit', 'plan', 'auto'];
      const s = sessions.find((x) => x.id === input.id);
      const next = order[(order.indexOf(s ? s.permissionMode : 'ask') + 1) % order.length];
      if (s) s.permissionMode = next;
      emit({ type: 'session:event', sessionId: input.id, event: { type: 'mode', permissionMode: next } });
      return next;
    }
  };

  /** For turns.js: a session's summary, and a way to tell the app it changed. */
  window.__sessions = {
    get: (id) => sessions.find((x) => x.id === id),
    update(id, patch) {
      const s = sessions.find((x) => x.id === id);
      if (!s) return;
      Object.assign(s, patch, { updatedAt: Date.now() });
      emit({ type: 'session:summary', summary: Object.assign({}, s) });
    },
    /** A session that already exists when the app starts, with its transcript. */
    seed(id, title, messages, extra) {
      sessions.push(summary(id, title, Object.assign({ createdAt: now - 4 * MIN, updatedAt: now - MIN }, extra)));
      details[id] = { messages };
    },
    setAppearance(patch) {
      Object.assign(settings.appearance, patch);
      emit({ type: 'settings:changed', settings: JSON.parse(JSON.stringify(settings)) });
    }
  };

  window.graft = {
    platform: 'win32',
    invoke(channel, input) {
      const handler = handlers[channel];
      if (!handler) {
        console.warn('[film] the bridge has no answer for', channel, JSON.stringify(input));
        return Promise.resolve({ ok: false, error: { code: 'preview', message: `No answer for ${channel}` } });
      }
      return Promise.resolve()
        .then(() => handler(input))
        .then(
          (value) => ({ ok: true, value }),
          (error) => {
            console.error('[film] the bridge failed on', channel, error);
            return { ok: false, error: { code: 'preview', message: String(error) } };
          }
        );
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
})();
