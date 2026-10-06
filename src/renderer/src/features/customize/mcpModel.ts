import type { McpServerView } from '@shared/schemas/customize';

export const STATE_TEXT: Record<McpServerView['state'], string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  failed: 'Failed',
  disabled: 'Off',
  'needs-auth': 'Sign-in needed',
  idle: 'Starts with a session in this project',
  untrusted: 'Off until you trust this project'
};

/** One line on what a server offers: its tools, and the prompts and resources it publishes besides. */
export function serverSummary(server: Pick<McpServerView, 'state' | 'tools' | 'prompts' | 'resources'>): string {
  if (server.state !== 'connected') return STATE_TEXT[server.state];
  if (server.tools.length === 0 && server.prompts.length === 0 && !server.resources) return `${STATE_TEXT.connected} · waiting for tools`;
  const parts = [
    ...(server.tools.length > 0 ? [`${String(server.tools.length)} ${server.tools.length === 1 ? 'tool' : 'tools'}`] : []),
    ...(server.prompts.length > 0 ? [`${String(server.prompts.length)} ${server.prompts.length === 1 ? 'prompt' : 'prompts'}`] : []),
    ...(server.resources ? ['resources'] : [])
  ];
  return `${STATE_TEXT.connected} · ${parts.join(' · ')}`;
}
