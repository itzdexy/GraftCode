import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fitWithin, toScreen, virtualKeys } from '../../src/main/computer/keys';
import type { ComputerAction, ComputerControl } from '../../src/main/computer/desktop';
import { WindowsInput } from '../../src/main/computer/windowsInput';
import { decide, type PermissionEnv, type PermissionQuery } from '../../src/main/permissions/engine';
import { computerTool, toAction } from '../../src/main/tools/computer';
import type { PermissionMode } from '../../src/shared/schemas/common';
import { makeToolContext } from '../support/toolContext';
import { makeHarness } from '../support/sessionHarness';
import { removeDir } from '../support/tmp';

describe('computer use helpers', () => {
  it('turns key names into Windows virtual-key codes', () => {
    expect(virtualKeys('ctrl+shift+s')).toEqual([0x11, 0x10, 0x53]);
    expect(virtualKeys('Alt + F4')).toEqual([0x12, 0x73]);
    expect(virtualKeys('enter')).toEqual([0x0d]);
    expect(virtualKeys('win+1')).toEqual([0x5b, 0x31]);
    expect(virtualKeys('ctrl+nope')).toBeNull();
    expect(virtualKeys('')).toBeNull();
    expect(virtualKeys('a+b+c+d+e')).toBeNull();
  });

  it('maps screenshot points to physical pixels, clamped to the display', () => {
    const shot = { width: 1280, height: 720, display: { x: 0, y: 0, width: 3840, height: 2160 } };
    expect(toScreen(640, 360, shot)).toEqual({ x: 1920, y: 1080 });
    expect(toScreen(1280, 720, shot)).toEqual({ x: 3839, y: 2159 });
    expect(fitWithin(3840, 2160, 1280, 800)).toEqual({ width: 1280, height: 720 });
    expect(fitWithin(1024, 768, 1280, 800)).toEqual({ width: 1024, height: 768 });
  });

  it('checks each action has what it needs', () => {
    expect(toAction({ action: 'click', x: 10, y: 20 })).toEqual({ kind: 'click', x: 10, y: 20, button: 'left', count: 1 });
    expect(toAction({ action: 'double_click', x: 1, y: 2 })).toMatchObject({ count: 2 });
    expect(toAction({ action: 'right_click', x: 1, y: 2 })).toMatchObject({ button: 'right' });
    expect(toAction({ action: 'click' })).toMatch(/needs x and y/);
    expect(toAction({ action: 'drag', x: 1, y: 2 })).toMatch(/to_x/);
    expect(toAction({ action: 'key', keys: 'ctrl+s' })).toEqual({ kind: 'key', vks: [0x11, 0x53] });
    expect(toAction({ action: 'key', keys: 'hyper+q' })).toMatch(/Unknown key/);
    expect(toAction({ action: 'screenshot' })).toBeNull();
  });
});

describe('the Computer tool', () => {
  function fake(): ComputerControl & { actions: ComputerAction[] } {
    const actions: ComputerAction[] = [];
    return {
      actions,
      act: (_id, action) => {
        actions.push(action);
        return Promise.resolve();
      },
      screenshot: () => Promise.resolve({ mediaType: 'image/jpeg', data: 'AAAA', width: 1280, height: 720 }),
      zoom: (_id, region) => {
        zooms.push(region);
        return Promise.resolve({ mediaType: 'image/jpeg', data: 'ZZZZ', width: 640, height: 400 });
      }
    };
  }
  const zooms: Array<{ x: number; y: number; toX: number; toY: number }> = [];

  it('acts, then answers with a fresh screenshot', async () => {
    const computer = fake();
    const ctx = makeToolContext(process.cwd(), { computer, modelSupportsVision: true });
    const result = await computerTool.execute({ action: 'click', x: 100, y: 200 }, ctx);
    expect(computer.actions).toEqual([{ kind: 'click', x: 100, y: 200, button: 'left', count: 1 }]);
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      { type: 'text', text: 'Clicked at 100, 200. Screenshot (1280×720):' },
      { type: 'image', mediaType: 'image/jpeg', data: 'AAAA' }
    ]);
    // The transcript shows the screenshot with the click marked on it.
    expect(result.display).toEqual({ kind: 'computer', action: 'click', summary: 'Clicked at 100, 200', point: { x: 100, y: 200 }, width: 1280, height: 720 });
  });

  it('opens an app by name and zooms in without moving the coordinate space', async () => {
    const computer = fake();
    const ctx = makeToolContext(process.cwd(), { computer, modelSupportsVision: true });
    const opened = await computerTool.execute({ action: 'open', text: 'Blender' }, ctx);
    expect(computer.actions).toEqual([{ kind: 'open', name: 'Blender' }]);
    expect(opened.display).toMatchObject({ kind: 'computer', summary: 'Opened Blender', point: null });
    const close = await computerTool.execute({ action: 'zoom', x: 10, y: 20, to_x: 300, to_y: 200 }, ctx);
    expect(zooms.at(-1)).toEqual({ x: 10, y: 20, toX: 300, toY: 200 });
    expect(JSON.stringify(close.content[0])).toContain("keep using the full screenshot's coordinates");
    expect(close.content[1]).toEqual({ type: 'image', mediaType: 'image/jpeg', data: 'ZZZZ' });
    expect((await computerTool.execute({ action: 'zoom', x: 10, y: 20 }, ctx)).isError).toBe(true);
    expect((await computerTool.execute({ action: 'open' }, ctx)).isError).toBe(true);
  });

  it('refuses when computer use is off, the model is blind, or input is missing', async () => {
    expect((await computerTool.execute({ action: 'screenshot' }, makeToolContext(process.cwd()))).isError).toBe(true);
    const blind = makeToolContext(process.cwd(), { computer: fake(), modelSupportsVision: false });
    expect(await computerTool.execute({ action: 'screenshot' }, blind)).toMatchObject({ isError: true });
    const ctx = makeToolContext(process.cwd(), { computer: fake(), modelSupportsVision: true });
    expect(await computerTool.execute({ action: 'type' }, ctx)).toMatchObject({ isError: true, display: { message: 'Typing needs text.' } });
  });

  it('asks before every action outside Bypass, and is off limits in Plan mode', () => {
    const env = (mode: PermissionMode, extra: Partial<PermissionEnv> = {}): PermissionEnv => ({
      mode,
      projectRoot: path.resolve('project'),
      platform: process.platform,
      rules: { allow: [], ask: [], deny: [] },
      ...extra
    });
    const query: PermissionQuery = { toolName: 'Computer', permissionClass: 'computer', descriptor: { summary: 'Clicked at 1, 2' } };
    expect(decide(query, env('ask'))).toMatchObject({ behavior: 'ask', suggestedRule: 'Computer' });
    expect(decide(query, env('auto'))).toMatchObject({ behavior: 'ask' });
    expect(decide(query, env('plan')).behavior).toBe('deny');
    expect(decide(query, env('bypass')).behavior).toBe('allow');
    expect(decide(query, env('bypass', { bypassKeepsChecks: true })).behavior).toBe('ask');
  });

  it('is offered only to code sessions with computer use on and a model that can see', async () => {
    const off = makeHarness({ script: [{ text: 'ok' }] });
    off.session.send('hi');
    await off.session.idle();
    expect(off.provider.requests[0]!.tools.map((t) => t.name)).not.toContain('Computer');
    const on = makeHarness({ computer: fake(), model: { supportsVision: true }, script: [{ text: 'ok' }] });
    on.session.send('hi');
    await on.session.idle();
    expect(on.provider.requests[0]!.tools.map((t) => t.name)).toContain('Computer');
    expect(on.provider.requests[0]!.system).toContain('Computer tool');
    const blind = makeHarness({ computer: fake(), model: { supportsVision: false }, script: [{ text: 'ok' }] });
    blind.session.send('hi');
    await blind.session.idle();
    expect(blind.provider.requests[0]!.tools.map((t) => t.name)).not.toContain('Computer');
    for (const h of [off, on, blind]) {
      await h.session.dispose();
      removeDir(h.projectDir);
      removeDir(h.home);
    }
  });
});

describe('Windows input helper', () => {
  // Reads the pointer, "moves" it to where it already is and reads it again: nothing on screen changes.
  it.runIf(process.platform === 'win32')('starts and round-trips the pointer position', async () => {
    const input = new WindowsInput();
    try {
      const before = await input.run({ op: 'cursor' });
      const [x, y] = before.split(' ').map(Number);
      await input.run({ op: 'move', x: x!, y: y! });
      expect(await input.run({ op: 'cursor' })).toBe(before);
      await expect(input.run({ op: 'key', vks: [] })).resolves.toBe('');
    } finally {
      input.dispose();
    }
  }, 60_000);
});
