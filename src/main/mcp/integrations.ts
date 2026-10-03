import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraftError } from '@shared/errors';
import { INTEGRATIONS, type Integration, type IntegrationLaunch, type IntegrationRuntime } from '@shared/integrations';
import type { McpServerInput } from '@shared/schemas/customize';
import { SECRET_REF, secretId, serverKey } from './mcpConfig';

/**
 * One-step MCP integrations (Blender, Roblox Studio, Unity, GitHub…): checks
 * what each needs on this computer and turns a choice into a server config.
 * Commands come only from the presets in shared/integrations.ts.
 */

type Platform = 'win32' | 'darwin' | 'linux';
type Exists = (file: string) => boolean;

const RUNTIME_COMMAND: Record<IntegrationRuntime, string> = { uv: 'uvx', node: 'npx' };

/** What stops an integration from working yet: the OS, a runtime, or the other app. */
export type IntegrationBlocker = { kind: 'platform' } | { kind: 'runtime'; runtime: IntegrationRuntime } | { kind: 'app'; path: string };

export interface IntegrationStatus {
  id: string;
  blocker: IntegrationBlocker | null;
}

function platformOf(platform: NodeJS.Platform): Platform | null {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : null;
}

/** Folders installers put uv and Node in, which a GUI app's PATH may not have picked up yet. */
function installDirs(platform: Platform, env: NodeJS.ProcessEnv): string[] {
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  const dirs =
    platform === 'win32'
      ? [
          path.join(home, '.local', 'bin'),
          path.join(home, '.cargo', 'bin'),
          env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : '',
          env.ProgramFiles ? path.join(env.ProgramFiles, 'nodejs') : '',
          env.APPDATA ? path.join(env.APPDATA, 'npm') : ''
        ]
      : [path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'), path.join(home, '.volta', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  return dirs.filter((d) => d.length > 0);
}

/** The full path of a command on PATH or in the usual install folders, or null. */
export function findCommand(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: Exists = fs.existsSync): string | null {
  const system = platformOf(platform);
  if (!system) return null;
  const extensions = system === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0) : [''];
  const dirs = [...(env.PATH ?? env.Path ?? '').split(path.delimiter), ...installDirs(system, env)].filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const file = path.join(dir, `${name}${ext}`);
      if (exists(file)) return file;
    }
  }
  return null;
}

function fill(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace('{LOCALAPPDATA}', env.LOCALAPPDATA ?? path.join(env.USERPROFILE ?? os.homedir(), 'AppData', 'Local'));
}

function launchFor(integration: Integration, platform: NodeJS.Platform): IntegrationLaunch | null {
  const system = platformOf(platform);
  return system ? (integration.launch[system] ?? null) : null;
}

/** The program a launch depends on that the other app installs (Roblox Studio's launcher), if any. */
function appTarget(launch: IntegrationLaunch, env: NodeJS.ProcessEnv): string | null {
  if (launch.type !== 'stdio') return null;
  if (launch.command.toLowerCase() === 'cmd.exe' && launch.args[0] === '/c' && launch.args[1]) return fill(launch.args[1], env);
  return path.isAbsolute(launch.command) ? launch.command : null;
}

export function integrationStatus(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: Exists = fs.existsSync): IntegrationStatus[] {
  return INTEGRATIONS.map((integration): IntegrationStatus => {
    const launch = launchFor(integration, platform);
    if (!launch) return { id: integration.id, blocker: { kind: 'platform' } };
    if (integration.runtime && !findCommand(RUNTIME_COMMAND[integration.runtime], platform, env, exists)) {
      return { id: integration.id, blocker: { kind: 'runtime', runtime: integration.runtime } };
    }
    const target = appTarget(launch, env);
    if (target && !exists(target)) return { id: integration.id, blocker: { kind: 'app', path: target } };
    return { id: integration.id, blocker: null };
  });
}

export interface IntegrationSetup {
  name: string;
  config: McpServerInput;
  /** Values to keep in the encrypted key store, by key-store id. */
  secrets: Record<string, string>;
}

/**
 * The user-scope server config for an integration and the values typed for
 * it. Secret fields go to the key store; the settings file only refers to
 * them. A runtime found outside PATH is used by its full path, so the server
 * starts even when the app's PATH predates the install.
 */
export function integrationSetup(
  id: string,
  values: Record<string, string>,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: Exists = fs.existsSync
): IntegrationSetup {
  const integration = INTEGRATIONS.find((i) => i.id === id);
  if (!integration) throw new GraftError('unknown_integration', 'That integration doesn’t exist.');
  const launch = launchFor(integration, platform);
  if (!launch) throw new GraftError('integration_unavailable', `${integration.name} isn’t available on this system.`);
  const key = serverKey('user', null, integration.serverName);
  const secrets: Record<string, string> = {};
  const entries: Record<string, string> = {};
  for (const field of integration.fields ?? []) {
    const value = (values[field.key] ?? '').trim();
    if (value.length === 0) {
      if (field.optional) continue;
      throw new GraftError('missing_value', `Enter the ${field.label.toLowerCase()} first.`);
    }
    const name = field.kind === 'bearer' ? 'Authorization' : field.key;
    const stored = field.kind === 'bearer' ? `Bearer ${value}` : value;
    if (field.secret) {
      const ref = secretId(key, name);
      secrets[ref] = stored;
      entries[name] = `${SECRET_REF}${ref}`;
    } else {
      entries[name] = stored;
    }
  }
  if (launch.type === 'http') {
    return { name: integration.serverName, config: { type: 'http', url: launch.url, headers: entries, keepHeaders: [], enabled: true }, secrets };
  }
  const runtime = integration.runtime ? findCommand(RUNTIME_COMMAND[integration.runtime], platform, env, exists) : null;
  return {
    name: integration.serverName,
    config: { type: 'stdio', command: runtime ?? fill(launch.command, env), args: launch.args.map((a) => fill(a, env)), env: entries, keepEnv: [], cwd: null, enabled: true },
    secrets
  };
}
