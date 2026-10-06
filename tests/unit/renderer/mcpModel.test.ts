import { describe, expect, it } from 'vitest';
import { serverSummary } from '../../../src/renderer/src/features/customize/mcpModel';

type Server = Parameters<typeof serverSummary>[0];

const tool = { name: 't', description: '', readOnly: false };
const prompt = { command: 'mcp__s__p', description: '', argumentHint: null };
const server = (over: Partial<Server> = {}): Server => ({ state: 'connected', tools: [], prompts: [], resources: false, ...over });

describe('what a server’s row says it offers', () => {
  it('counts its tools, then the prompts it publishes, and says when it has resources', () => {
    expect(serverSummary(server({ tools: [tool] }))).toBe('Connected · 1 tool');
    expect(serverSummary(server({ tools: [tool, tool], prompts: [prompt] }))).toBe('Connected · 2 tools · 1 prompt');
    expect(serverSummary(server({ tools: [tool], prompts: [prompt, prompt], resources: true }))).toBe('Connected · 1 tool · 2 prompts · resources');
  });

  it('does not call a server that only publishes prompts or resources empty', () => {
    expect(serverSummary(server({ prompts: [prompt] }))).toBe('Connected · 1 prompt');
    expect(serverSummary(server({ resources: true }))).toBe('Connected · resources');
    expect(serverSummary(server())).toBe('Connected · waiting for tools');
  });

  it('says where a server that is not connected stands', () => {
    expect(serverSummary(server({ state: 'failed' }))).toBe('Failed');
    expect(serverSummary(server({ state: 'needs-auth' }))).toBe('Sign-in needed');
  });
});
