import { describe, expect, it } from 'vitest';
import { brandOf, connectorName, inkOn } from '../../../src/renderer/src/lib/brands';

const stdio = (command: string, args: string[] = []) => ({ type: 'stdio' as const, command, args, envKeys: [], cwd: null, inherit: 'no-secrets' as const, enabled: true });
const http = (url: string) => ({ type: 'http' as const, url, headerKeys: [], enabled: true });

describe('the app a connector reaches', () => {
  it('is known by the server’s name, whatever its case and separators', () => {
    expect(brandOf({ name: 'roblox_studio' })?.title).toBe('Roblox Studio');
    expect(brandOf({ name: 'Roblox_Studio' })?.title).toBe('Roblox Studio');
    expect(brandOf({ name: 'blender' })?.title).toBe('Blender');
    expect(brandOf({ name: 'unity-mcp' })?.title).toBe('Unity');
    expect(brandOf({ name: 'godot' })?.title).toBe('Godot Engine');
  });

  it('is known by a remote server’s address, or by the command that starts a local one', () => {
    expect(brandOf({ name: 'design', config: http('https://mcp.figma.com/mcp') })?.title).toBe('Figma');
    expect(brandOf({ name: 'issues', config: http('https://mcp.linear.app/sse') })?.title).toBe('Linear');
    expect(brandOf({ name: '3d', config: stdio('uvx', ['mcp-for-blender']) })?.title).toBe('Blender');
    expect(brandOf({ name: 'studio', config: stdio('cmd.exe', ['/c', 'C:\\Users\\me\\AppData\\Local\\Roblox\\mcp.bat']) })?.title).toBe('Roblox Studio');
  });

  it('is nobody’s for a server of one’s own', () => {
    expect(brandOf({ name: 'test', config: stdio('node', ['server.mjs']) })).toBeNull();
    expect(brandOf({ name: 'notes', config: http('not a url') })).toBeNull();
  });
});

describe('a connector’s name for people', () => {
  it('is the one the server gives itself, else its integration’s, else its own', () => {
    expect(connectorName({ name: 'rich', title: 'Graft Rich Notes' })).toBe('Graft Rich Notes');
    expect(connectorName({ name: 'roblox_studio' })).toBe('Roblox Studio');
    expect(connectorName({ name: 'roblox_studio', title: null })).toBe('Roblox Studio');
    expect(connectorName({ name: 'Roblox_Studio' })).toBe('Roblox Studio');
    expect(connectorName({ name: 'my-tools' })).toBe('my-tools');
  });
});

describe('the ink on a brand’s color', () => {
  it('is white, as app icons draw it, and black only where white would vanish', () => {
    expect(inkOn('000000')).toBe('#ffffff');
    expect(inkOn('00A2FF')).toBe('#ffffff');
    expect(inkOn('E87D0D')).toBe('#ffffff');
    expect(inkOn('F24E1E')).toBe('#ffffff');
    expect(inkOn('FFD700')).toBe('#000000');
    expect(inkOn('FFFFFF')).toBe('#000000');
  });
});
