import type { McpServerConfig } from '@shared/schemas/config';
import type { McpServerInput, McpServerView } from '@shared/schemas/customize';

/** Config as shown in the UI: names of environment variables and headers, never their values. */
export function maskConfig(config: McpServerConfig): McpServerView['config'] {
  if (config.type === 'stdio') {
    return { type: 'stdio', command: config.command, args: config.args, envKeys: Object.keys(config.env), cwd: config.cwd ?? null, enabled: config.enabled };
  }
  return { type: 'http', url: config.url, headerKeys: Object.keys(config.headers), enabled: config.enabled };
}

/** Builds the stored config from a UI save, keeping secret values the user left unchanged. */
export function mergeMcpConfig(input: McpServerInput, previous: McpServerConfig | undefined): McpServerConfig {
  if (input.type === 'stdio') {
    const kept = previous?.type === 'stdio' ? Object.fromEntries(Object.entries(previous.env).filter(([k]) => input.keepEnv.includes(k))) : {};
    return { type: 'stdio', command: input.command, args: input.args, env: { ...kept, ...input.env }, ...(input.cwd ? { cwd: input.cwd } : {}), enabled: input.enabled };
  }
  const kept = previous?.type === 'http' ? Object.fromEntries(Object.entries(previous.headers).filter(([k]) => input.keepHeaders.includes(k))) : {};
  return { type: 'http', url: input.url, headers: { ...kept, ...input.headers }, enabled: input.enabled };
}

/** Key under which a server's OAuth data is stored. */
export function serverKey(scope: string, projectRoot: string | null, name: string): string {
  return `${scope}:${projectRoot ?? ''}:${name}`;
}

/**
 * Secret values of env vars and headers can live in the encrypted key store,
 * with only a reference in the settings file: `graft-secret:<id>`. An id
 * belongs to one server (its scope, project and name), and a reference
 * resolves only for that server, so a settings file can't send another
 * server's secret, or a provider key, anywhere else.
 */
export const SECRET_REF = 'graft-secret:';

export function secretId(key: string, field: string): string {
  return `mcp-secret:${key}:${field}`;
}

/** Replaces this server's secret references with their values; a missing or foreign one is an error. */
export function resolveSecrets(values: Record<string, string>, key: string, get: (id: string) => string | null): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => {
      if (!value.startsWith(SECRET_REF)) return [name, value];
      const id = value.slice(SECRET_REF.length);
      if (!id.startsWith(secretId(key, ''))) throw new Error(`${name} refers to a secret that belongs to another server.`);
      const secret = get(id);
      if (secret === null) throw new Error(`The saved value of ${name} is missing. Add the server again to enter it.`);
      return [name, secret];
    })
  );
}

/** Ids of the secrets a server's config refers to (removed with the server). */
export function secretRefs(config: McpServerConfig): string[] {
  const values = config.type === 'stdio' ? Object.values(config.env) : Object.values(config.headers);
  return values.filter((v) => v.startsWith(SECRET_REF)).map((v) => v.slice(SECRET_REF.length));
}
