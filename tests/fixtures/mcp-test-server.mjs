// A tiny stdio MCP server used by unit and E2E tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'graft-test', version: '1.0.0' });

server.registerTool(
  'shout',
  {
    description: 'Returns the text in upper case.',
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true }
  },
  ({ text }) => ({ content: [{ type: 'text', text: text.toUpperCase() }] })
);

server.registerTool(
  'save-note',
  {
    description: 'Pretends to save a note.',
    inputSchema: { note: z.string() }
  },
  ({ note }) => ({ content: [{ type: 'text', text: `Saved: ${note}` }] })
);

await server.connect(new StdioServerTransport());
