export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Ordered, append-only list. Never edit a shipped migration; add a new one.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE app_settings (
  section TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  custom_models TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  blob BLOB NOT NULL,
  encrypted INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  trusted INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'code')),
  title TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  cwd TEXT,
  worktree_path TEXT,
  branch TEXT,
  base_branch TEXT,
  provider_id TEXT,
  model_id TEXT,
  effort TEXT,
  permission_mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  usage TEXT NOT NULL,
  todos TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_sessions_list ON sessions (archived, kind, updated_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, seq)
) STRICT;

CREATE VIRTUAL TABLE search_index USING fts5(
  session_id UNINDEXED,
  message_id UNINDEXED,
  title,
  body,
  tokenize = 'trigram'
);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  repo_dir TEXT NOT NULL,
  git_dir TEXT NOT NULL,
  ref TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_checkpoints_session ON checkpoints (session_id, created_at);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,
  project_path TEXT NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  effort TEXT,
  permission_mode TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  session_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  error TEXT
) STRICT;
CREATE INDEX idx_schedule_runs ON schedule_runs (schedule_id, started_at DESC);
`
  },
  {
    version: 2,
    name: 'provider presets',
    sql: `
ALTER TABLE providers ADD COLUMN preset TEXT;
UPDATE providers SET preset = CASE kind
  WHEN 'anthropic' THEN 'anthropic'
  WHEN 'openai' THEN 'openai'
  WHEN 'gemini' THEN 'google'
  WHEN 'openrouter' THEN 'openrouter'
  WHEN 'ollama' THEN 'ollama'
  ELSE NULL
END;
`
  },
  {
    version: 3,
    name: 'agent runs',
    sql: `
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_agent_runs_session ON agent_runs (session_id, created_at);
`
  },
  {
    version: 4,
    name: 'missions',
    sql: `
CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_missions_session ON missions (session_id, created_at);
`
  },
  {
    version: 5,
    name: 'durable context pruning',
    sql: `ALTER TABLE sessions ADD COLUMN prune_before_seq INTEGER NOT NULL DEFAULT 0 CHECK (prune_before_seq >= 0);`
  },
  {
    version: 6,
    name: 'provider model metadata snapshots',
    sql: `CREATE TABLE provider_model_snapshots (
      provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
      data TEXT NOT NULL
    ) STRICT;`
  },
  {
    version: 7,
    name: 'editor draft recovery',
    sql: `CREATE TABLE editor_drafts (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, path)
    ) STRICT;`
  }
];
