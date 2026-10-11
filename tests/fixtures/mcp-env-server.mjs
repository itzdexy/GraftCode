// A stdio MCP server that says which environment variables it was started with (tests only).
// It answers with names, never values.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'graft-env', version: '1.0.0' });

server.registerTool(
  'has',
  {
    description: 'Says which of the named environment variables this server has.',
    inputSchema: { names: z.array(z.string()) },
    annotations: { readOnlyHint: true }
  },
  ({ names }) => ({ content: [{ type: 'text', text: names.filter((name) => process.env[name] !== undefined).join(', ') }] })
);

await server.connect(new StdioServerTransport());
