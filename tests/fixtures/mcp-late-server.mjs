// A stdio MCP server whose tools behave like real-world bridges (tests only):
//   late    - starts with no tools, then announces them (Roblox Studio's proxy does this)
//   silent  - tools appear without any announcement; the client has to ask again
//   crash   - exits right after answering a call
// Every mode has `render`, a slow tool that reports progress.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const mode = process.argv[2] ?? 'late';
const started = Date.now();
const ready = () => mode === 'crash' || Date.now() - started > 400;
const tools = [
  { name: 'ping', description: 'Answers pong.', inputSchema: { type: 'object', properties: {} } },
  { name: 'render', description: 'Takes a while and reports progress.', inputSchema: { type: 'object', properties: {} } }
];

const server = new Server({ name: 'graft-late', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: ready() ? tools : [] }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === 'render') {
    const token = request.params._meta?.progressToken;
    for (let i = 1; i <= 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: i, total: 4, message: 'Rendering' } });
    }
    return { content: [{ type: 'text', text: 'rendered' }] };
  }
  if (mode === 'crash') setTimeout(() => process.exit(1), 50);
  return { content: [{ type: 'text', text: 'pong' }] };
});
await server.connect(new StdioServerTransport());
if (mode === 'late') setTimeout(() => void server.sendToolListChanged(), 500);
