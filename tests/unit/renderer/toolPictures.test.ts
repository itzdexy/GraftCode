import { describe, expect, it } from 'vitest';
import type { ToolResultBlock } from '../../../src/shared/schemas/messages';
import { pictureName, pictureSrc, picturesToDraw, resultPictures } from '../../../src/renderer/src/features/session/toolPictures';
import { queueHeadline } from '../../../src/renderer/src/features/session/queueModel';

const png = { type: 'image' as const, mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' };
const text = { type: 'text' as const, text: 'Rendered the viewport.' };

describe('the pictures a tool sent back', () => {
  it('are the image blocks of its result, in order', () => {
    const result: ToolResultBlock = { type: 'tool_result', toolUseId: 't', isError: false, content: [text, png, png], display: { kind: 'mcp', server: 'blender', tool: 'look', text: 'Rendered the viewport.' } };
    expect(resultPictures(result)).toEqual([png, png]);
    expect(picturesToDraw(result)).toEqual([png, png]);
    expect(resultPictures(null)).toEqual([]);
  });

  it('are left to the details that already draw them', () => {
    const read: ToolResultBlock = { type: 'tool_result', toolUseId: 't', isError: false, content: [png], display: { kind: 'read', path: 'shot.png', startLine: 0, endLine: 0, totalLines: 0, image: true } };
    expect(resultPictures(read)).toEqual([png]);
    expect(picturesToDraw(read)).toEqual([]);
    expect(picturesToDraw({ type: 'tool_result', toolUseId: 't', isError: false, content: [png] })).toEqual([png]);
  });

  it('open under the call’s own words', () => {
    expect(pictureSrc(png)).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(pictureName('blender · look', 0, 1)).toBe('blender · look');
    expect(pictureName('Captured the screen', 1, 3)).toBe('Captured the screen (2 of 3)');
  });
});

describe('the folded queue', () => {
  const queued = (id: string, text: string, attachmentCount = 0) => ({ id, text, steer: false, attachmentCount, createdAt: 1 });

  it('says how many wait and starts the next one on one line', () => {
    expect(queueHeadline([])).toBeNull();
    expect(queueHeadline([queued('a', 'Continue  the\nexisting project')])).toEqual({ count: '1 message queued', next: 'Continue the existing project' });
    expect(queueHeadline([queued('a', 'Look at this', 2), queued('b', 'Then this')])).toEqual({ count: '2 messages queued', next: 'Look at this (+2 attachments)' });
  });
});
