import { afterEach, describe, expect, it } from 'vitest';
import { searchTools, type SearchableTool } from '../../src/main/tools/toolSearch';
import { testTool } from '../support/loopHarness';
import { makeHarness, type Harness } from '../support/sessionHarness';
import { removeDir } from '../support/tmp';
import type { ToolDefinition } from '../../src/main/tools/types';

const tools: SearchableTool[] = [
  { name: 'mcp__github__create_issue', server: 'github', description: 'Creates an issue in a repository.' },
  { name: 'mcp__github__list_pull_requests', server: 'github', description: 'Lists the pull requests of a repository.' },
  { name: 'mcp__github__get_file_contents', server: 'github', description: 'Reads a file from a repository.' },
  { name: 'mcp__playwright__browser_click', server: 'playwright', description: 'Clicks an element on the page.' },
  { name: 'mcp__playwright__browser_navigate', server: 'playwright', description: 'Opens a URL in the browser.' },
  { name: 'mcp__blender__render_scene', server: 'blender', description: 'Renders the scene to an image.' }
];

describe('searching the tools that are not loaded', () => {
  it('finds a tool by the words of its name, ahead of tools that only mention them', () => {
    expect(searchTools(tools, 'create issue', 5)[0]?.name).toBe('mcp__github__create_issue');
    expect(searchTools(tools, 'pull requests', 5)[0]?.name).toBe('mcp__github__list_pull_requests');
    expect(searchTools(tools, 'click', 5)[0]?.name).toBe('mcp__playwright__browser_click');
  });

  it('finds the tools of a server by its name', () => {
    expect(searchTools(tools, 'playwright', 5).map((t) => t.name)).toEqual(['mcp__playwright__browser_click', 'mcp__playwright__browser_navigate']);
  });

  it('finds a tool by what its description says', () => {
    expect(searchTools(tools, 'image', 5).map((t) => t.name)).toEqual(['mcp__blender__render_scene']);
  });

  it('takes exact names after select:, whatever their case, and skips names that do not exist', () => {
    expect(searchTools(tools, 'select:mcp__blender__render_scene, MCP__PLAYWRIGHT__BROWSER_CLICK, nope', 5).map((t) => t.name)).toEqual([
      'mcp__blender__render_scene',
      'mcp__playwright__browser_click'
    ]);
  });

  it('loads all of a server’s tools when the search is just its name, however many it has', () => {
    const many: SearchableTool[] = Array.from({ length: 36 }, (_, i) => ({ name: `mcp__blender__tool_${String(i).padStart(2, '0')}`, server: 'blender', description: 'Does something in Blender.' }));
    const all = [...many, ...tools];
    // The 36 made here and the one every test shares.
    expect(searchTools(all, 'blender', 8)).toHaveLength(37);
    expect(searchTools(all, 'Blender tools', 8)).toHaveLength(37);
    // With other words in the search, the limit applies as usual.
    expect(searchTools(all, 'blender render', 8)).toHaveLength(8);
  });

  it('ignores filler words, returns nothing when nothing matches, and never more than asked for', () => {
    expect(searchTools(tools, 'the tool to render', 5).map((t) => t.name)).toEqual(['mcp__blender__render_scene']);
    expect(searchTools(tools, 'quantum teleport', 5)).toEqual([]);
    expect(searchTools(tools, 'repository', 2)).toHaveLength(2);
    expect(searchTools(tools, '   ', 5)).toEqual([]);
  });
});

let harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses) {
    await h.session.dispose();
    removeDir(h.projectDir);
    removeDir(h.home);
  }
  harnesses = [];
});

function mcpTool(server: string, tool: string, description: string): ToolDefinition<Record<string, unknown>> {
  return { ...testTool(`mcp__${server}__${tool}`, { safe: true, run: () => `${tool} done` }), description, mcp: { server, tool, readOnly: true, destructive: false } };
}

/** Twelve tools whose definitions weigh about 2,500 tokens together, more than a model with a 20,000-token window should carry. */
function bigSetup(): Array<ToolDefinition<Record<string, unknown>>> {
  const filler = 'It works on the connected service and returns what the service answers. '.repeat(8);
  const named = [
    ['github', 'create_issue', 'Creates an issue in a repository.'],
    ['github', 'list_pull_requests', 'Lists the pull requests of a repository.'],
    ['github', 'get_file_contents', 'Reads a file from a repository.']
  ] as const;
  return [
    ...named.map(([server, tool, description]) => mcpTool(server, tool, `${description} ${filler}`)),
    ...Array.from({ length: 9 }, (_, i) => mcpTool('crm', `record_${String(i)}`, `Handles customer record kind ${String(i)}. ${filler}`))
  ];
}

function harness(...args: Parameters<typeof makeHarness>): Harness {
  const h = makeHarness(...args);
  harnesses.push(h);
  return h;
}

describe('MCP tools that wait to be loaded', () => {
  it('leaves the tools of a big setup out of every request until the agent asks for them', async () => {
    const h = harness({
      model: { contextWindow: 20_000 },
      mcpTools: bigSetup(),
      script: [
        { toolCalls: [{ name: 'ToolSearch', input: { query: 'issue' } }] },
        { toolCalls: [{ name: 'mcp__github__create_issue', input: {} }] },
        { text: 'Done.' },
        { text: 'Again.' }
      ],
      mode: 'bypass',
      bypassEnabled: true
    });
    h.session.send('Open an issue about the crash.');
    await h.session.idle();
    const first = h.provider.requests[0]!;
    expect(first.tools.map((t) => t.name)).toContain('ToolSearch');
    expect(first.tools.filter((t) => t.name.startsWith('mcp__'))).toEqual([]);
    // The prompt says what is waiting, by server, so the agent knows what to search for.
    expect(first.system).toContain('# Tools you can load');
    expect(first.system).toMatch(/github \(3 tools\)/);
    expect(first.system).toMatch(/crm \(9 tools\)/);
    // The search loaded what matched, for this request onward.
    const second = h.provider.requests[1]!;
    expect(second.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['ToolSearch', 'mcp__github__create_issue']));
    expect(second.tools.some((t) => t.name.startsWith('mcp__crm__'))).toBe(false);
    expect(JSON.stringify(second.messages.at(-1))).toContain('mcp__github__create_issue');
    // And the loaded tool ran.
    expect(JSON.stringify(h.provider.requests[2]!.messages.at(-1))).toContain('create_issue done');
    // The next message still has it: what was loaded stays loaded for the session.
    h.session.send('Thanks.');
    await h.session.idle();
    expect(h.provider.requests.at(-1)!.tools.map((t) => t.name)).toContain('mcp__github__create_issue');
  });

  it('offers a small setup straight away, with no search to go through', async () => {
    const h = harness({
      mcpTools: [mcpTool('github', 'create_issue', 'Creates an issue.'), mcpTool('github', 'get_file', 'Reads a file.')],
      script: [{ text: 'Hi.' }]
    });
    h.session.send('hello');
    await h.session.idle();
    const request = h.provider.requests[0]!;
    expect(request.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['mcp__github__create_issue', 'mcp__github__get_file']));
    expect(request.tools.map((t) => t.name)).not.toContain('ToolSearch');
    expect(request.system).not.toContain('# Tools you can load');
  });

  it('says what to try when nothing matches', async () => {
    const h = harness({
      model: { contextWindow: 20_000 },
      mcpTools: bigSetup(),
      script: [{ toolCalls: [{ name: 'ToolSearch', input: { query: 'quantum teleport' } }] }, { text: 'Nothing there.' }]
    });
    h.session.send('Teleport something.');
    await h.session.idle();
    const result = JSON.stringify(h.provider.requests[1]!.messages.at(-1));
    expect(result).toMatch(/No tool that is not loaded matches/);
    expect(result).toContain('github');
    expect(h.provider.requests[1]!.tools.filter((t) => t.name.startsWith('mcp__'))).toEqual([]);
  });
});
