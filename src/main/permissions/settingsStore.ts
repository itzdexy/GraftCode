import fs from 'node:fs';
import path from 'node:path';
import { GraftError } from '@shared/errors';
import type { PermissionMode } from '@shared/schemas/common';
import {
  SettingsFileSchema,
  type ChecksConfig,
  type HookEvent,
  type HookMatcher,
  type McpServerConfig,
  type SettingsFile,
  type SettingsScope
} from '@shared/schemas/config';
import { writeFileAtomic } from '../tools/fs/write';
import { parseRule, type Rule } from './rules';
import type { RuleSet } from './engine';

export interface LoadedSettings {
  scope: SettingsScope;
  path: string;
  settings: SettingsFile;
  /** Parse/validation problem, shown in Settings; the file is then ignored. */
  error: string | null;
}

export interface ScopedHook extends HookMatcher {
  scope: SettingsScope;
}

export interface ScopedMcpServer {
  name: string;
  scope: SettingsScope;
  config: McpServerConfig;
}

/**
 * Reads and writes Graft settings files. Project and local files come from
 * the repository, so their allow rules, hooks and MCP servers only apply
 * once the user has trusted the project; their deny/ask rules always apply.
 */
export class SettingsStore {
  constructor(private readonly graftHome: string) {}

  filePath(scope: SettingsScope, projectRoot?: string): string {
    if (scope === 'user') return path.join(this.graftHome, 'settings.json');
    if (!projectRoot) throw new GraftError('project_required', `A project folder is required for ${scope} settings.`);
    return path.join(projectRoot, '.graft', scope === 'project' ? 'settings.json' : 'settings.local.json');
  }

  load(scope: SettingsScope, projectRoot?: string): LoadedSettings {
    const file = this.filePath(scope, projectRoot);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { scope, path: file, settings: {}, error: null };
      return { scope, path: file, settings: {}, error: `Can't read ${file}: ${(error as Error).message}` };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (error) {
      return { scope, path: file, settings: {}, error: `${file} is not valid JSON: ${(error as Error).message}` };
    }
    const parsed = SettingsFileSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { scope, path: file, settings: {}, error: `${file}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}` };
    }
    return { scope, path: file, settings: parsed.data, error: null };
  }

  /** Applies a change to one settings file, preserving unknown keys. */
  async update(scope: SettingsScope, projectRoot: string | undefined, change: (current: SettingsFile) => SettingsFile): Promise<SettingsFile> {
    const loaded = this.load(scope, projectRoot);
    if (loaded.error) throw new GraftError('settings_invalid', `${loaded.error}. Fix the file before changing it here.`);
    const next = SettingsFileSchema.parse(change(structuredClone(loaded.settings)));
    await writeFileAtomic(loaded.path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  private scopes(projectRoot: string | null): LoadedSettings[] {
    const all = [this.load('user')];
    if (projectRoot) all.push(this.load('project', projectRoot), this.load('local', projectRoot));
    return all;
  }

  /** Merged rules. `sessionAllow` holds "Allow for session" grants. */
  rules(projectRoot: string | null, trusted: boolean, sessionAllow: string[] = []): { rules: RuleSet; problems: string[] } {
    const rules: RuleSet = { allow: [], ask: [], deny: [] };
    const problems: string[] = [];
    for (const loaded of this.scopes(projectRoot)) {
      if (loaded.error) {
        problems.push(loaded.error);
        continue;
      }
      const p = loaded.settings.permissions;
      if (!p) continue;
      for (const kind of ['allow', 'ask', 'deny'] as const) {
        if (kind === 'allow' && loaded.scope !== 'user' && !trusted) continue;
        for (const raw of p[kind]) {
          const rule = parseRule(raw, loaded.scope);
          if (rule) rules[kind].push(rule);
          else problems.push(`Ignored invalid ${kind} rule "${raw}" in ${loaded.path}`);
        }
      }
    }
    for (const raw of sessionAllow) {
      const rule = parseRule(raw, 'session');
      if (rule) rules.allow.push(rule);
    }
    return { rules, problems };
  }

  defaultMode(projectRoot: string | null, trusted: boolean): PermissionMode | null {
    let mode: PermissionMode | null = null;
    for (const loaded of this.scopes(projectRoot)) {
      if (loaded.scope !== 'user' && !trusted) continue;
      mode = loaded.settings.permissions?.defaultMode ?? mode;
    }
    return mode;
  }

  hooks(projectRoot: string | null, trusted: boolean): Partial<Record<HookEvent, ScopedHook[]>> {
    const out: Partial<Record<HookEvent, ScopedHook[]>> = {};
    for (const loaded of this.scopes(projectRoot)) {
      if (loaded.error || (loaded.scope !== 'user' && !trusted)) continue;
      for (const [event, matchers] of Object.entries(loaded.settings.hooks ?? {}) as Array<[HookEvent, HookMatcher[]]>) {
        (out[event] ??= []).push(...matchers.map((m) => ({ ...m, scope: loaded.scope })));
      }
    }
    return out;
  }

  mcpServers(projectRoot: string | null, trusted: boolean): ScopedMcpServer[] {
    const byName = new Map<string, ScopedMcpServer>();
    for (const loaded of this.scopes(projectRoot)) {
      if (loaded.error || (loaded.scope !== 'user' && !trusted)) continue;
      for (const [name, config] of Object.entries(loaded.settings.mcpServers ?? {})) {
        byName.set(name, { name, scope: loaded.scope, config });
      }
    }
    return [...byName.values()];
  }

  /**
   * The project's checks: this computer's (local) over the shared ones. They
   * come from the repository and run commands, so like hooks they apply only
   * once the project is trusted; there are no user-wide checks.
   */
  checks(projectRoot: string | null, trusted: boolean): ChecksConfig | null {
    if (!projectRoot || !trusted) return null;
    const local = this.load('local', projectRoot);
    if (!local.error && local.settings.checks) return local.settings.checks;
    const shared = this.load('project', projectRoot);
    return !shared.error && shared.settings.checks ? shared.settings.checks : null;
  }

  async addRule(scope: SettingsScope, projectRoot: string | undefined, kind: 'allow' | 'ask' | 'deny', raw: string): Promise<void> {
    if (!parseRule(raw, scope)) throw new GraftError('invalid_rule', `"${raw}" is not a valid rule. Use Tool or Tool(pattern).`);
    await this.update(scope, projectRoot, (s) => {
      const permissions = s.permissions ?? { allow: [], ask: [], deny: [] };
      if (!permissions[kind].includes(raw)) permissions[kind].push(raw);
      return { ...s, permissions };
    });
  }
}

export type { Rule };
