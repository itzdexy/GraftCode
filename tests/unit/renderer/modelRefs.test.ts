import { describe, expect, it } from 'vitest';
import { MAX_TURN_MODELS, turnModels } from '../../../src/renderer/src/features/session/modelRefs';
import { groupActivity, type ToolCall, type TranscriptItem } from '../../../src/renderer/src/features/session/transcriptModel';

const wrote = (id: string, path: string, isError = false): ToolCall => ({
  id,
  name: 'Write',
  input: {},
  running: null,
  result: { type: 'tool_result', toolUseId: id, isError, content: [], display: { kind: 'edit', path, created: true, patch: '', added: 1, removed: 0 } }
});

describe('the 3D models of a turn', () => {
  it('are the model files its tools wrote, then those its replies name in code spans', () => {
    const calls = [wrote('1', 'models/ring.obj'), wrote('2', 'src/x.ts'), wrote('3', 'broken.gltf', true)];
    const texts = ['Exported `exports/AK74M.fbx` and `exports/AK74M.fbx:12`, kept `models/ring.obj`.', 'See `notes.md` and `C:\\Users\\dexy\\art\\ship.glb`, not exports/plain.glb.'];
    expect(turnModels(texts, calls)).toEqual(['models/ring.obj', 'exports/AK74M.fbx', 'C:/Users/dexy/art/ship.glb']);
  });

  it('are at most a few', () => {
    const texts = [Array.from({ length: 9 }, (_, i) => `\`m${String(i)}.glb\``).join(' ')];
    expect(turnModels(texts, [])).toHaveLength(MAX_TURN_MODELS);
  });

  it('end a finished turn, after its diagrams, and not a running one', () => {
    const items: TranscriptItem[] = [
      { kind: 'tools', key: 't1', calls: [wrote('1', 'models/ring.obj')], at: 1 },
      { kind: 'text', key: 'x1', messageId: 'm', text: 'Saved `models/ring.obj`.', live: false, closing: true, endOfTurn: true, at: 2 }
    ];
    expect(groupActivity(items, false, 'normal').map((i) => i.kind)).toEqual(['activity', 'text', 'edits', 'models']);
    expect(groupActivity(items, true, 'normal').map((i) => i.kind)).not.toContain('models');
  });
});
