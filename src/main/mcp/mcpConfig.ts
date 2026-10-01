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
