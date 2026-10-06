// The agent's side of each scene: scripted turns that reach the renderer as the same
// session events the main process sends, so what is on screen is the app's own rendering of
// them. Timing runs on the film's clock, and the pacing is each turn's own.
(function () {
  const PROJECT = 'C:/Users/robin/code/acme-api';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const emit = (sessionId, event) => window.__graftEmit({ type: 'session:event', sessionId, event });

  // The same film every time it is shot: a seeded generator instead of Math.random.
  let seed = 20261006;
  function random() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  let seq = 1000;
  let ids = 0;
  const id = (prefix) => `${prefix}${String(++ids)}`;
  const stored = (sessionId, role, content, meta) => ({ id: id('m'), sessionId, seq: ++seq, role, content, meta: meta || {}, createdAt: Date.now() });

  const active = {};
  const runs = {};
  const stats = {};
  const asking = {};
  const deciding = {};
  const finished = {};

  // ---------- The pieces of a turn ----------

  /** Text arrives the way a fast model sends it: small uneven bursts. `rate` is characters a second. */
  async function stream(sessionId, messageId, kind, text, rate) {
    let i = 0;
    while (i < text.length) {
      const size = 2 + Math.floor(random() * 9);
      emit(sessionId, { type: 'assistant-delta', messageId, kind, text: text.slice(i, i + size) });
      i += size;
      await sleep((size / rate) * 1000 * (0.6 + random() * 0.8));
    }
  }

  /** One assistant message: optional text, then the tools it calls. */
  async function assistant(sessionId, turnId, parts) {
    const messageId = id('a');
    emit(sessionId, { type: 'assistant-start', messageId });
    if (parts.text) await stream(sessionId, messageId, 'text', parts.text, parts.rate || 240);
    const content = [];
    if (parts.text) content.push({ type: 'text', text: parts.text });
    for (const call of parts.calls || []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    emit(sessionId, { type: 'message', message: Object.assign(stored(sessionId, 'assistant', content, { turnId }), { id: messageId }) });
  }

  /** Runs the tools one after another, then hands their results back as one message. */
  async function tools(sessionId, turnId, calls) {
    const results = [];
    for (const call of calls) {
      emit(sessionId, { type: 'tool-start', toolUseId: call.id, name: call.name, summary: call.summary });
      for (const chunk of call.progress || []) {
        await sleep(call.beat || 180);
        emit(sessionId, { type: 'tool-progress', toolUseId: call.id, chunk });
      }
      await sleep(call.ms);
      results.push({ type: 'tool_result', toolUseId: call.id, isError: false, content: [{ type: 'text', text: 'ok' }], display: call.display });
    }
    emit(sessionId, { type: 'message', message: stored(sessionId, 'user', results, { turnId }) });
  }

  const read = (path, lines, ms) => ({ id: id('t'), name: 'Read', input: { file_path: path }, summary: `Read ${path}`, ms, display: { kind: 'read', path, startLine: 1, endLine: lines, totalLines: lines, image: false } });
  const edit = (path, patch, added, removed, ms) => ({ id: id('t'), name: 'Edit', input: { file_path: path, old_string: '', new_string: '' }, summary: `Edit ${path}`, ms, display: { kind: 'edit', path, created: false, patch, added, removed } });
  const shell = (command, description, output, ms, progress) => ({
    id: id('t'),
    name: 'Shell',
    input: { command, description },
    summary: description,
    ms,
    progress,
    display: { kind: 'shell', command, cwd: PROJECT, exitCode: 0, output, truncated: false, logPath: null, durationMs: 1240, timedOut: false, interrupted: false, backgroundId: null }
  });

  /** Asks the person before a tool runs, and waits for the answer. */
  async function ask(sessionId, call, request) {
    const requestId = id('p');
    asking[sessionId] = Object.assign({ id: requestId, sessionId, toolUseId: call.id, toolName: call.name, title: call.summary, dangerous: null, outsideProject: false, agentLabel: null }, request);
    window.__sessions.update(sessionId, { status: 'needs-input' });
    emit(sessionId, { type: 'status', status: 'needs-input', error: null });
    emit(sessionId, { type: 'permission', request: asking[sessionId] });
    const decision = await new Promise((resolve) => (deciding[requestId] = resolve));
    delete asking[sessionId];
    emit(sessionId, { type: 'permission-resolved', requestId });
    window.__sessions.update(sessionId, { status: 'running' });
    emit(sessionId, { type: 'status', status: 'running', error: null });
    return decision;
  }

  /** The project's checks after a change: the strip while they run, then what they said. */
  async function checks(sessionId, turnId, round, results, ms) {
    emit(sessionId, { type: 'checks', commands: results.map((r) => r.command), round });
    await sleep(ms);
    const report = {
      passed: results.every((r) => r.passed),
      round,
      runs: results.map((r) => ({ command: r.command, exitCode: r.passed ? 0 : 1, output: r.output, truncated: false, durationMs: r.durationMs, timedOut: false, passed: r.passed }))
    };
    emit(sessionId, { type: 'message', message: stored(sessionId, 'user', [{ type: 'text', text: 'checks' }], { turnId, kind: 'check', check: report }) });
  }

  // ---------- "The /health endpoint returns 500 …": read, fix, test, report ----------

  const HEALTH_PATCH = [
    '--- a/src/health.js',
    '+++ b/src/health.js',
    '@@ -1,4 +1,8 @@',
    ' export async function health(db) {',
    '-  const ok = await db.ping();',
    "-  return { status: 200, body: { database: ok ? 'up' : 'down' } };",
    '+  try {',
    '+    const ok = await db.ping();',
    "+    return { status: 200, body: { database: ok ? 'up' : 'down' } };",
    '+  } catch {',
    "+    return { status: 200, body: { database: 'degraded' } };",
    '+  }',
    ' }'
  ].join('\n');
  const HEALTH_TEST_PATCH = [
    '--- a/test/health.test.js',
    '+++ b/test/health.test.js',
    '@@ -8,3 +8,8 @@',
    "   assert.deepEqual(result, { status: 200, body: { database: 'up' } });",
    ' });',
    '+',
    "+test('reports degraded when the database is unreachable', async () => {",
    "+  const result = await health({ ping: async () => { throw new Error('ECONNREFUSED'); } });",
    "+  assert.deepEqual(result, { status: 200, body: { database: 'degraded' } });",
    '+});'
  ].join('\n');
  const TEST_LINES = ['✔ reports the database as up (1.1ms)\n', '✔ reports degraded when the database is unreachable (0.4ms)\n', 'ℹ tests 2\n', 'ℹ pass 2\n', 'ℹ fail 0\n'];

  async function code(sessionId, turnId) {
    await sleep(380);
    emit(sessionId, { type: 'title', title: 'Health check reports degraded' });
    window.__sessions.update(sessionId, { title: 'Health check reports degraded' });

    let calls = [read('src/health.js', 4, 260), read('test/health.test.js', 10, 240)];
    await assistant(sessionId, turnId, { text: 'I’ll read the health check and its test first.', calls });
    await tools(sessionId, turnId, calls);

    calls = [edit('src/health.js', HEALTH_PATCH, 6, 2, 420), edit('test/health.test.js', HEALTH_TEST_PATCH, 5, 0, 380)];
    await assistant(sessionId, turnId, { text: 'A failed ping throws out of `health()`, so the route answers 500. I’ll catch it and report the database as degraded.', calls });
    await tools(sessionId, turnId, calls);
    stats[sessionId] = { added: 11, removed: 2, files: 2 };

    calls = [shell('node --test', 'Run the tests', TEST_LINES.join('').trimEnd(), 260, TEST_LINES)];
    await assistant(sessionId, turnId, { calls });
    await tools(sessionId, turnId, calls);

    await assistant(sessionId, turnId, {
      rate: 300,
      text: 'Fixed. **`health()`** now catches a failed database ping and reports `degraded`, so `/health` answers with the state instead of a 500.\n\n- `src/health.js`: the ping runs inside `try`/`catch`\n- `test/health.test.js`: a new test for an unreachable database\n\n`node --test`: 2 passed.'
    });
    return { inputTokens: 18400, outputTokens: 1260, cacheReadTokens: 52000, cacheWriteTokens: 9100, contextTokens: 21800, costUsd: 0.0826 };
  }

  // ---------- "Add structured request logging.": in Ask mode, installing a package asks first ----------

  async function logging(sessionId, turnId) {
    let calls = [read('src/server.js', 38, 300)];
    await assistant(sessionId, turnId, { text: 'I’ll look at how the server logs today.', calls });
    await tools(sessionId, turnId, calls);

    const install = shell('npm install pino pino-http', 'Install the logger', 'added 24 packages in 2s', 380, ['added 24 packages in 2s\n']);
    await assistant(sessionId, turnId, { text: 'It writes with `console.log` in three places. I’ll add pino and log each request once, as JSON.', calls: [install] });
    const decision = await ask(sessionId, install, { detail: { kind: 'command', command: 'npm install pino pino-http', cwd: PROJECT, background: false }, reason: 'Runs a command.', suggestedRule: 'Shell(npm install:*)' });
    if (decision === 'deny') return null;
    await tools(sessionId, turnId, [install]);
    await assistant(sessionId, turnId, { text: 'Installed. Next I’ll wire the request logger into `src/server.js`.' });
    return { inputTokens: 9200, outputTokens: 410, cacheReadTokens: 21000, cacheWriteTokens: 5200, contextTokens: 12400, costUsd: 0.0397 };
  }

  // ---------- "Make /health say healthy instead of up.": the checks catch what the change broke ----------

  const WORD_PATCH = ['--- a/src/health.js', '+++ b/src/health.js', '@@ -2,3 +2,3 @@', '   try {', '     const ok = await db.ping();', "-    return { status: 200, body: { database: ok ? 'up' : 'down' } };", "+    return { status: 200, body: { database: ok ? 'healthy' : 'down' } };", '   } catch {'].join('\n');
  const WORD_TEST_PATCH = ['--- a/test/health.test.js', '+++ b/test/health.test.js', '@@ -6,3 +6,3 @@', "   const result = await health({ ping: async () => true });", "-  assert.deepEqual(result, { status: 200, body: { database: 'up' } });", "+  assert.deepEqual(result, { status: 200, body: { database: 'healthy' } });", ' });'].join('\n');
  const TEST_FAILURE = ['✖ reports the database as up (1.8ms)', '  AssertionError: Expected values to be strictly deep-equal:', "  +   database: 'healthy'", "  -   database: 'up'", 'ℹ pass 1', 'ℹ fail 1'].join('\n');

  async function wording(sessionId, turnId) {
    let calls = [edit('src/health.js', WORD_PATCH, 1, 1, 360)];
    await assistant(sessionId, turnId, { text: 'I’ll change the word the health check reports.', calls });
    await tools(sessionId, turnId, calls);
    stats[sessionId] = { added: 1, removed: 1, files: 1 };
    await assistant(sessionId, turnId, { text: 'Done: the health check now says `healthy`.' });

    await checks(sessionId, turnId, 1, [{ command: 'npm run lint', passed: true, output: '', durationMs: 640 }, { command: 'npm test', passed: false, output: TEST_FAILURE, durationMs: 910 }], 1150);
    await sleep(900);

    calls = [edit('test/health.test.js', WORD_TEST_PATCH, 1, 1, 360)];
    await assistant(sessionId, turnId, { text: 'Lint is clean, but a test still expects the old word. Updating it.', calls });
    await tools(sessionId, turnId, calls);
    stats[sessionId] = { added: 2, removed: 2, files: 2 };

    await checks(sessionId, turnId, 2, [{ command: 'npm run lint', passed: true, output: '', durationMs: 610 }, { command: 'npm test', passed: true, output: 'ℹ tests 2\nℹ pass 2\nℹ fail 0', durationMs: 880 }], 1050);
    await assistant(sessionId, turnId, { text: 'Both checks pass now.' });
    return { inputTokens: 14100, outputTokens: 620, cacheReadTokens: 38000, cacheWriteTokens: 4300, contextTokens: 16900, costUsd: 0.0527 };
  }

  // ---------- "Add rate limiting to the public API.": a group of agents, as the graph the main process runs ----------

  const SONNET = { providerId: 'anthropic', modelId: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' };
  const HAIKU = { providerId: 'anthropic', modelId: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' };
  const QUICK = ['Automatic routing: Claude Haiku 4.5 is the cheapest model from the same provider that can do quick reading work.'];
  const STRONG = ['The session model: changing code needs its strongest reasoning.'];
  const AGENTS = [
    { id: 'routes', role: 'Explorer', task: 'Map the API routes', deps: [], model: HAIKU, routing: QUICK, ms: 1250, tools: ['Glob', 'Grep', 'Read'], steps: ['Listed files matching src/routes/**', 'Searched for “router.”', 'Read src/routes/public.js'], result: 'Public routes live in `src/routes/public.js:14`. Every handler goes through `withAuth` except `/health`.' },
    { id: 'tests', role: 'Explorer', task: 'Find how routes are tested', deps: [], model: HAIKU, routing: QUICK, ms: 1600, tools: ['Glob', 'Grep', 'Read'], steps: ['Listed files matching test/**', 'Read test/routes.test.js', 'Searched for “supertest”'], result: 'Route tests use supertest in `test/routes.test.js`, with a shared `makeApp()` helper.' },
    { id: 'docs', role: 'Researcher', task: 'Check the limiter’s docs', deps: [], model: HAIKU, routing: QUICK, ms: 1950, tools: ['WebFetch', 'WebSearch'], steps: ['Searched the web for “express-rate-limit options”', 'Read express-rate-limit.mintlify.app/reference/configuration'], result: 'Use `limit` (not `max`) and `standardHeaders: "draft-8"`.' },
    { id: 'build', role: 'Implementer', task: 'Add the limiter middleware', deps: ['routes', 'tests', 'docs'], model: SONNET, routing: STRONG, exclusive: true, ms: 2100, tools: ['Read', 'Edit', 'Write', 'Shell', 'Glob', 'Grep'], steps: ['Read src/routes/public.js', 'Created src/middleware/rateLimit.js', 'Edited src/routes/public.js', 'Edited test/routes.test.js', 'Ran npm test'], verify: 'npm test', files: ['src/middleware/rateLimit.js', 'src/routes/public.js', 'test/routes.test.js'], result: 'Added `rateLimit()` and applied it to the public router: 60 requests a minute per IP, `/health` exempt.' },
    { id: 'review', role: 'Final reviewer', task: 'Review the change', deps: ['build'], model: SONNET, routing: ['The session model: reviews need its strongest reasoning.'], ms: 1250, tools: ['Read', 'Glob', 'Grep'], steps: ['Read src/middleware/rateLimit.js', 'Read src/routes/public.js'], result: 'No blocking findings.' },
    { id: 'security', role: 'Security reviewer', task: 'Check for bypasses', deps: ['build'], model: SONNET, routing: ['The session model: reviews need its strongest reasoning.'], ms: 1600, tools: ['Read', 'Glob', 'Grep'], steps: ['Searched for “x-forwarded-for”', 'Read src/app.js'], result: 'The limiter keys on `req.ip`, so set `trust proxy` behind a load balancer.' }
  ];
  const TOOL_OF = [['Read ', 'Read'], ['Searched the web', 'WebSearch'], ['Searched', 'Grep'], ['Listed', 'Glob'], ['Ran', 'Shell'], ['Created', 'Write']];

  async function group(sessionId, turnId) {
    await sleep(300);
    emit(sessionId, { type: 'title', title: 'Rate limit the public API' });
    window.__sessions.update(sessionId, { title: 'Rate limit the public API' });
    await assistant(sessionId, turnId, { text: 'This splits cleanly: three things to find out, one change, two reviews. I’ll run it as a group.' });

    const groupId = id('g');
    const goal = 'Add rate limiting to the public API';
    const created = Date.now();
    const state = {};
    const save = (nodeId, patch, entry) => {
      const run = Object.assign({}, state[nodeId], patch);
      run.rev = (state[nodeId] ? state[nodeId].rev : -1) + 1;
      if (entry) run.timeline = run.timeline.concat([Object.assign({ at: Date.now() }, entry)]);
      state[nodeId] = run;
      runs[sessionId] = (runs[sessionId] || []).filter((r) => r.id !== run.id).concat([run]);
      emit(sessionId, { type: 'agent-run', run });
    };
    for (const spec of AGENTS) {
      save(spec.id, {
        id: id('r'), sessionId, groupId, goal, nodeId: spec.id, role: spec.role.toLowerCase(), roleLabel: spec.role, title: spec.task,
        prompt: `Goal: ${goal}.\n\nYour task: ${spec.task}. Report what you find with path:line references.`,
        dependsOn: spec.deps, status: 'queued', attempt: 0, maxAttempts: 2, model: spec.model, routing: spec.routing, tools: spec.tools,
        exclusive: spec.exclusive === true, writes: [], budget: { maxTokens: 400000, timeoutMs: spec.exclusive ? 45 * 60000 : 15 * 60000 }, createdAt: created, startedAt: null, endedAt: null,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: null, toolCalls: 0, toolsUsed: {}, filesChanged: [], result: '', error: null, retries: [],
        verify: spec.verify ? { command: spec.verify, passed: null, output: '', rounds: 0 } : null, timeline: []
      });
    }
    const toolUseId = id('t');
    emit(sessionId, { type: 'tool-start', toolUseId, name: 'RunAgents', summary: `Ran ${String(AGENTS.length)} agents: ${goal}` });

    const work = async (spec) => {
      const price = spec.model === HAIKU ? 0.000001 : 0.000002;
      save(spec.id, { status: 'running', attempt: 1, startedAt: Date.now() }, { kind: 'start', text: `Started on ${spec.model.label}` });
      for (const step of spec.steps) {
        await sleep(spec.ms / spec.steps.length);
        const now = state[spec.id];
        const name = (TOOL_OF.find(([start]) => step.startsWith(start)) || [null, 'Edit'])[1];
        const used = Object.assign({}, now.toolsUsed);
        used[name] = (used[name] || 0) + 1;
        const tokens = 2400 + Math.floor(random() * 5200);
        save(
          spec.id,
          {
            toolCalls: now.toolCalls + 1,
            toolsUsed: used,
            usage: { inputTokens: now.usage.inputTokens + tokens, outputTokens: now.usage.outputTokens + 180, cacheReadTokens: now.usage.cacheReadTokens + tokens * 2, cacheWriteTokens: 0 },
            costUsd: (now.costUsd || 0) + tokens * price,
            filesChanged: spec.files && (name === 'Write' || name === 'Edit') ? spec.files.slice(0, now.filesChanged.length + 1) : now.filesChanged
          },
          { kind: 'tool', text: step }
        );
        emit(sessionId, { type: 'tool-progress', toolUseId, chunk: `${spec.id}: ${step}\n` });
      }
      if (spec.verify) {
        await sleep(420);
        save(spec.id, { verify: { command: spec.verify, passed: true, output: 'ℹ tests 14\nℹ pass 14\nℹ fail 0', rounds: 1 } }, { kind: 'verify', text: `Check passed: ${spec.verify}` });
      }
      save(spec.id, { status: 'done', endedAt: Date.now(), result: spec.result }, { kind: 'end', text: 'Finished' });
    };

    // The readers side by side, then the one that changes files, then the reviewers side by side.
    for (const step of [AGENTS.slice(0, 3), AGENTS.slice(3, 4), AGENTS.slice(4)]) await Promise.all(step.map(work));

    const agents = AGENTS.map((spec) => ({ nodeId: spec.id, title: spec.task, role: spec.role, status: 'done', durationMs: state[spec.id].endedAt - state[spec.id].startedAt }));
    emit(sessionId, { type: 'message', message: stored(sessionId, 'assistant', [{ type: 'tool_use', id: toolUseId, name: 'RunAgents', input: { goal, agents: AGENTS.map((s) => ({ id: s.id, role: s.role, task: s.task, prompt: '' })) } }], { turnId }) });
    emit(sessionId, { type: 'message', message: stored(sessionId, 'user', [{ type: 'tool_result', toolUseId, isError: false, content: [{ type: 'text', text: 'ok' }], display: { kind: 'agents', goal, agents } }], { turnId }) });
    stats[sessionId] = { added: 41, removed: 3, files: 3 };
    await assistant(sessionId, turnId, { text: 'Rate limiting is in: 60 requests a minute per IP on the public router, `/health` exempt, and `npm test` passes. One note from the security review: set `trust proxy` before this runs behind a load balancer.' });
    return { inputTokens: 61000, outputTokens: 5200, cacheReadTokens: 210000, cacheWriteTokens: 14000, contextTokens: 57400, costUsd: 0.2513 };
  }

  const TURNS = { code, logging, wording, group };

  /** Runs a named turn in a session: the events around it are the ones a real turn sends. */
  async function run(sessionId, name, text) {
    if (active[sessionId]) return;
    active[sessionId] = true;
    const turnId = id('turn');
    window.__sessions.update(sessionId, { status: 'running' });
    emit(sessionId, { type: 'status', status: 'running', error: null });
    emit(sessionId, { type: 'turn-start', turnId });
    if (text) emit(sessionId, { type: 'message', message: stored(sessionId, 'user', [{ type: 'text', text }], { turnId, typed: text }) });
    let usage = null;
    try {
      usage = await TURNS[name](sessionId, turnId);
    } finally {
      delete active[sessionId];
      finished[sessionId] = (finished[sessionId] || 0) + 1;
      if (usage) emit(sessionId, { type: 'usage', usage: { totals: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens }, contextTokens: usage.contextTokens, contextLimit: 1000000, costUsd: usage.costUsd } });
      emit(sessionId, { type: 'turn-end', turnId, reason: 'completed' });
      emit(sessionId, { type: 'status', status: 'idle', error: null });
      window.__sessions.update(sessionId, { status: 'idle' });
    }
  }

  window.__turns = {
    /** The turn the next sent message starts; a scene sets it before it types. */
    play: 'code',
    send(sessionId, text) {
      if (active[sessionId]) return { queued: true };
      void run(sessionId, this.play, text);
      return { queued: false };
    },
    /** Starts a turn in a session whose message is already in the transcript. */
    resume(sessionId, name) {
      void run(sessionId, name, null);
    },
    interrupt() {},
    decide(requestId, decision) {
      const resolve = deciding[requestId];
      delete deciding[requestId];
      if (resolve) resolve(decision);
    },
    pendingPermission: (sessionId) => asking[sessionId] || null,
    agentRuns: (sessionId) => runs[sessionId] || [],
    /** How many turns a session has finished; a scene waits on it. */
    finished: (sessionId) => finished[sessionId] || 0,
    diffStats: (sessionId) => Object.assign({ added: 0, removed: 0, files: 0, base: 'main', branch: 'main' }, stats[sessionId]),
    /** A stored message, for sessions a scene opens part-way through. */
    message: (sessionId, role, content, meta) => stored(sessionId, role, content, meta)
  };
})();
