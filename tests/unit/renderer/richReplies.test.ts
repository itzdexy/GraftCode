import { describe, expect, it } from 'vitest';
import { nextImageZoom } from '../../../src/renderer/src/features/session/ImageViewer';
import { SNAKE_LENGTH, startSnake, stepSnake } from '../../../src/renderer/src/features/session/snakeModel';
import { svgImage } from '../../../src/renderer/src/features/session/svgPreview';
import { generatingImage, liveLabel, searchingLabel, type ActivityItem, type ToolCall } from '../../../src/renderer/src/features/session/transcriptModel';

function call(name: string, input: unknown, over: Partial<ToolCall> = {}): ToolCall {
  return { id: `${name}-1`, name, input, result: null, running: null, ...over };
}

function found(...urls: string[]): ToolCall['result'] {
  return { type: 'tool_result', toolUseId: 't', isError: false, content: [], display: { kind: 'web-search', query: 'q', results: urls.map((url) => ({ title: url, url })) } };
}

function block(...calls: ToolCall[]): ActivityItem {
  return { kind: 'activity', key: 'a', live: true, startedAt: 0, endedAt: 0, steps: calls.map((c, i) => ({ kind: 'tool', key: String(i), call: c })) };
}

describe('the grid a picture is made on', () => {
  it('walks one cell at a time, stays on the grid and keeps its length', () => {
    const cols = 22;
    const rows = 11;
    let snake = startSnake(cols, rows);
    expect(snake.body).toHaveLength(SNAKE_LENGTH);
    for (let i = 0; i < 3000; i++) {
      const before = snake.body[0]!;
      snake = stepSnake(snake, cols, rows);
      const head = snake.body[0]!;
      expect(Math.abs(head.x - before.x) + Math.abs(head.y - before.y)).toBe(1);
      expect(head.x >= 0 && head.x < cols && head.y >= 0 && head.y < rows).toBe(true);
      expect(snake.body).toHaveLength(SNAKE_LENGTH);
      expect(snake.food.x >= 0 && snake.food.x < cols && snake.food.y >= 0 && snake.food.y < rows).toBe(true);
    }
  });

  it('reaches the dot it walks to, and a new dot appears somewhere it is not', () => {
    let snake = startSnake(22, 11);
    const first = snake.food;
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      snake = stepSnake(snake, 22, 11);
      reached = snake.food !== first;
    }
    expect(reached).toBe(true);
    expect(snake.body.some((c) => c.x === snake.food.x && c.y === snake.food.y)).toBe(false);
  });

  it('turns aside rather than back onto itself when the dot is behind it', () => {
    const snake = { body: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }], food: { x: 1, y: 5 }, seed: 1 };
    const head = stepSnake(snake, 22, 11).body[0];
    expect(head).toEqual({ x: 5, y: 6 });
  });
});

describe('a drawing in a code block', () => {
  const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

  it('shows a complete SVG as a picture, adding the namespace an image needs', () => {
    const address = svgImage(svg, 'svg');
    expect(address?.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(address!.split(',')[1]!)).toBe(svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"'));
    expect(decodeURIComponent(svgImage('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'xml')!.split(',')[1]!)).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  });

  it('accepts an XML declaration and comments before the drawing, and an unlabelled block', () => {
    expect(svgImage(`<?xml version="1.0"?>\n<!-- a dot -->\n${svg}`, 'xml')).not.toBeNull();
    expect(svgImage(svg, null)).not.toBeNull();
  });

  it('leaves everything else as code', () => {
    expect(svgImage('<svg viewBox="0 0 10 10"><circle', 'svg')).toBeNull();
    expect(svgImage(`<html><body>${svg}</body></html>`, 'html')).toBeNull();
    expect(svgImage(`<p>before</p>${svg}`, 'html')).toBeNull();
    expect(svgImage(svg, 'tsx')).toBeNull();
    expect(svgImage('const a = 1;', 'svg')).toBeNull();
    expect(svgImage(`<svg>${'x'.repeat(400_001)}</svg>`, 'svg')).toBeNull();
  });
});

describe('what a turn that searches and draws says while it works', () => {
  it('counts the pages its searches have found so far, each once', () => {
    const first = call('WebSearch', { query: 'a' }, { result: found('https://a.example/1', 'https://b.example/2') });
    const running = call('WebSearch', { query: 'b' }, { running: { summary: 'Searching', output: '' } });
    expect(searchingLabel(block(running))).toBe('Searching the web');
    expect(liveLabel(block(first, running))).toBe('Searching 2 websites');
    const again = call('WebSearch', { query: 'c' }, { result: found('https://a.example/1', 'https://c.example/3') });
    expect(liveLabel(block(first, again, running))).toBe('Searching 3 websites');
    expect(searchingLabel(block(call('WebSearch', { query: 'a' }, { result: found('https://a.example/1') })))).toBe('Searching 1 website');
  });

  it('knows a picture is being made only while its call runs', () => {
    const input = { prompt: 'a cat on the moon', path: 'cat.png' };
    expect(generatingImage(call('GenerateImage', input))).toBeNull();
    expect(generatingImage(call('GenerateImage', input, { running: { summary: 'Generate cat.png', output: '' } }))).toEqual({ label: 'Creating image', note: null });
    expect(generatingImage(call('ComfyUI', { action: 'run' }, { running: { summary: '', output: 'Queued in ComfyUI\nGenerating… 12s\n' } }))).toEqual({ label: 'Running the workflow', note: 'Generating… 12s' });
    expect(generatingImage(call('ComfyUI', { action: 'status' }, { running: { summary: '', output: '' } }))).toBeNull();
    expect(generatingImage(call('GenerateImage', input, { running: { summary: '', output: '' }, result: found() }))).toBeNull();
    expect(generatingImage(call('Shell', { command: 'ls' }, { running: { summary: '', output: '' } }))).toBeNull();
  });
});

describe('the picture viewer', () => {
  it('steps the zoom up and down from the size shown, and stops at the ends', () => {
    expect(nextImageZoom('fit', 1)).toBe(1.5);
    expect(nextImageZoom('fit', -1)).toBe(0.75);
    expect(nextImageZoom(4, 1)).toBe(4);
    expect(nextImageZoom(0.25, -1)).toBe(0.25);
  });
});
