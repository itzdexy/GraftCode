import { expect, it } from 'vitest';
import type { StoredMessage } from '../../../src/shared/schemas/messages';
import { buildTranscript, groupActivity } from '../../../src/renderer/src/features/session/transcriptModel';
import { createTranscriptProjection } from '../../../src/renderer/src/features/session/transcriptProjection';

function conversation(turns: number): StoredMessage[] {
  return Array.from({ length: turns * 2 }, (_, seq) => ({
    id: `m${seq}`, sessionId: 'benchmark', seq, role: seq % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: [{ type: 'text' as const, text: seq % 2 === 0 ? `Question ${seq}` : 'A useful answer. '.repeat(20) }],
    meta: {}, createdAt: seq
  }));
}

it('measures the actual projection pipeline over 500 turns and 120 stream updates', () => {
  const messages = conversation(500);
  const running = {};
  const start = performance.now();
  let output: ReturnType<typeof groupActivity> = [];
  for (let i = 0; i < 120; i++) output = groupActivity(buildTranscript(messages, { streaming: { messageId: 'live', text: 'new text '.repeat(i + 1), thinking: '' }, running }), true);
  const duration = performance.now() - start;
  expect(output.filter(item => item.kind === 'user')).toHaveLength(500);
  console.log(JSON.stringify({ benchmark: 'transcript-baseline', turns: 500, updates: 120, durationMs: Math.round(duration * 100) / 100 }));
  const project = createTranscriptProjection();
  const optimizedStart = performance.now();
  for (let i = 0; i < 120; i++) output = project(messages, { streaming: { messageId: 'live', text: 'new text '.repeat(i + 1), thinking: '' }, running }, true);
  const optimized = performance.now() - optimizedStart;
  expect(output.filter(item => item.kind === 'user')).toHaveLength(500);
  console.log(JSON.stringify({ benchmark: 'transcript-cached', turns: 500, updates: 120, durationMs: Math.round(optimized * 100) / 100 }));
});
