import type { AgentRun } from '../../../src/shared/schemas/agentRuns';

/** An agent of a group as the store keeps it: finished, with nothing recorded, unless `extra` says otherwise. */
export function makeAgentRun(nodeId: string, dependsOn: string[] = [], extra: Partial<AgentRun> = {}): AgentRun {
  return {
    id: `run-${extra.groupId ?? 'g1'}-${nodeId}`,
    sessionId: 's',
    groupId: 'g1',
    goal: 'Ship it',
    nodeId,
    role: 'explorer',
    roleLabel: 'Explorer',
    title: nodeId,
    prompt: '',
    dependsOn,
    status: 'done',
    rev: 0,
    attempt: 1,
    maxAttempts: 2,
    model: null,
    routing: [],
    tools: [],
    exclusive: false,
    writes: [],
    budget: { maxTokens: null, timeoutMs: 60_000 },
    createdAt: 1,
    startedAt: 1,
    endedAt: 2,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: null,
    toolCalls: 0,
    toolsUsed: {},
    filesChanged: [],
    result: '',
    error: null,
    retries: [],
    verify: null,
    timeline: [],
    ...extra
  };
}
