// A stdio MCP server that uses more of the protocol than tools: instructions, resources,
// a resource template, a prompt, structured output and the client's roots. Used by unit tests.
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'graft-rich', version: '1.0.0' },
  { instructions: 'Call "count" before anything else. Notes live in the note:// resources.' }
);

server.registerResource(
  'readme',
  'notes://readme',
  { title: 'Readme', description: 'What this server holds', mimeType: 'text/markdown' },
  () => ({ contents: [{ uri: 'notes://readme', text: '# Rich server\nNotes live here.' }] })
);

server.registerResource(
  'note',
  new ResourceTemplate('note://{id}', {
    list: () => ({
      resources: [
        { uri: 'note://1', name: 'First note' },
        { uri: 'note://2', name: 'Second note' }
      ]
    })
  }),
  { description: 'A note by number' },
  (uri, { id }) => ({ contents: [{ uri: uri.href, text: `Note ${id}` }] })
);

server.registerPrompt(
  'review',
  { description: 'Review a file', argsSchema: { file: z.string().describe('The file to review') } },
  ({ file }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Please review ${file} for bugs.` } }] })
);

// Only structured output: no text blocks.
server.registerTool('count', { description: 'Counts to three.', outputSchema: { total: z.number() } }, () => ({
  content: [],
  structuredContent: { total: 3 }
}));

server.registerTool('where', { description: 'Lists the folders the client says it works in.' }, async () => {
  const { roots } = await server.server.listRoots();
  return { content: [{ type: 'text', text: roots.map((r) => r.uri).join('\n') || '(none)' }] };
});

await server.connect(new StdioServerTransport());
