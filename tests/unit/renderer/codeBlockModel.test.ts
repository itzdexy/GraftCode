import { describe, expect, it } from 'vitest';
import { drawRequest, fenceInfo, foldedCode, lineCount, terminalLine } from '../../../src/renderer/src/features/session/codeBlockModel';

const at = (path: string) => ({ path, line: null, endLine: null, column: null });
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${String(i + 1)}`).join('\n');

describe('what a fence says about its block', () => {
  it('names a language and, when one is given, a file', () => {
    expect(fenceInfo('ts', null)).toEqual({ language: 'ts', ref: null });
    expect(fenceInfo('ts', 'src/app.ts')).toEqual({ language: 'ts', ref: at('src/app.ts') });
    expect(fenceInfo('ts', 'title="src/app.ts"')).toEqual({ language: 'ts', ref: at('src/app.ts') });
    expect(fenceInfo('ts', "filename='src/app.ts' {1,3}")).toEqual({ language: 'ts', ref: at('src/app.ts') });
    expect(fenceInfo('ts', 'filename=src/app.ts')).toEqual({ language: 'ts', ref: at('src/app.ts') });
    expect(fenceInfo('src/app.ts', null)).toEqual({ language: null, ref: at('src/app.ts') });
    expect(fenceInfo('ts', '{1,3}')).toEqual({ language: 'ts', ref: null });
    expect(fenceInfo(null, null)).toEqual({ language: null, ref: null });
  });

  it('keeps the line a file is named with, and takes a language for a language', () => {
    expect(fenceInfo('ts', 'src/app.ts:42')).toEqual({ language: 'ts', ref: { path: 'src/app.ts', line: 42, endLine: null, column: null } });
    expect(fenceInfo('dockerfile', null)).toEqual({ language: 'dockerfile', ref: null });
    expect(fenceInfo('c++', 'showLineNumbers')).toEqual({ language: 'c++', ref: null });
    expect(fenceInfo('ts', 'title="not a file"')).toEqual({ language: 'ts', ref: null });
  });
});

describe('folding', () => {
  it('shows the first 20 lines of a finished block of more than 40', () => {
    expect(lineCount(lines(41))).toBe(41);
    expect(foldedCode(lines(41), false, false)).toEqual({ shown: 20, total: 41, folded: true });
    expect(foldedCode(lines(41), false, true)).toEqual({ shown: 41, total: 41, folded: false });
    expect(foldedCode(lines(40), false, false)).toEqual({ shown: 40, total: 40, folded: false });
  });

  it('never folds a block that is still being written', () => {
    expect(foldedCode(lines(500), true, false)).toEqual({ shown: 500, total: 500, folded: false });
  });

  it('counts an empty block as no lines', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('one')).toBe(1);
  });
});

describe('a command for the terminal', () => {
  it('is one line of a shell language, without its prompt', () => {
    expect(terminalLine('npm test\n', 'bash')).toBe('npm test');
    expect(terminalLine('$ npm test', 'sh')).toBe('npm test');
    expect(terminalLine('> dir', 'cmd')).toBe('dir');
    expect(terminalLine('Get-ChildItem', 'PowerShell')).toBe('Get-ChildItem');
    for (const language of ['bash', 'sh', 'shell', 'zsh', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat']) expect(terminalLine('ls', language), language).toBe('ls');
  });

  it('is nothing for several lines, another language, or too much', () => {
    expect(terminalLine('cd app\nnpm test', 'bash')).toBeNull();
    expect(terminalLine('npm test', 'ts')).toBeNull();
    expect(terminalLine('npm test', null)).toBeNull();
    expect(terminalLine('   \n', 'bash')).toBeNull();
    expect(terminalLine('$ ', 'bash')).toBeNull();
    expect(terminalLine('x'.repeat(2001), 'bash')).toBeNull();
    expect(terminalLine('x'.repeat(2000), 'bash')).toHaveLength(2000);
  });

  it('is nothing when it holds a key press: a carriage return would run it', () => {
    expect(terminalLine('echo hi\rrm -rf x', 'bash')).toBeNull();
    expect(terminalLine('echo hi\u001b[A', 'bash')).toBeNull();
    expect(terminalLine('echo\thi', 'bash')).toBeNull();
    expect(terminalLine('echo hi\u0003', 'bash')).toBeNull();
    expect(terminalLine('echo hi\u0085', 'bash')).toBeNull();
    expect(terminalLine('echo “héllo” 你好', 'bash')).toBe('echo “héllo” 你好');
  });
});

describe('asking for a Mermaid block to be drawn', () => {
  it('names the block by its first line', () => {
    expect(drawRequest('graph TD\n  A --> B')).toBe('/diagram Redraw the Mermaid diagram from your last reply that begins "graph TD"');
    expect(drawRequest(`\n  flowchart LR "${'x'.repeat(80)}"`)).toBe(`/diagram Redraw the Mermaid diagram from your last reply that begins "flowchart LR '${'x'.repeat(46)}"`);
  });
});
