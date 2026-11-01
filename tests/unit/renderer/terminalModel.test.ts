import { describe, expect, it } from 'vitest';
import type { Mark } from '../../../src/shared/terminalMarks';
import {
  BlockTracker,
  commandAttachment,
  explainQuestion,
  failed,
  MAX_BLOCKS,
  outputTail,
  selectionAttachment,
  TAIL_LINES,
  type CommandBlock,
  type Screen,
  type Spot
} from '../../../src/renderer/src/features/panels/terminalModel';

// Made up, in the shape of a real key; never issued.
const KEY = `sk-ant-api03-${'a1B2c3D4'.repeat(6)}`;

/** A screen of plain lines with a cursor, standing in for xterm's buffer. */
class FakeScreen implements Screen<number> {
  readonly lines: string[] = [''];
  readonly released: Array<Spot<number>> = [];
  private row = 0;
  private col = 0;

  write(text: string): void {
    for (const char of text) {
      if (char === '\n') {
        this.row++;
        this.col = 0;
        this.lines[this.row] ??= '';
      } else {
        const line = this.lines[this.row] ?? '';
        this.lines[this.row] = line.slice(0, this.col) + char + line.slice(this.col + 1);
        this.col++;
      }
    }
  }

  here(): Spot<number> {
    return { line: this.row, col: this.col };
  }

  text(from: Spot<number>, to: Spot<number>, count?: number): string {
    const first = count === undefined ? from.line : Math.max(from.line, to.line - count + 1);
    const out: string[] = [];
    for (let y = first; y <= to.line; y++) out.push((this.lines[y] ?? '').slice(y === from.line ? from.col : 0, y === to.line ? to.col : undefined).trimEnd());
    return out.join('\n');
  }

  release(spot: Spot<number>): void {
    this.released.push(spot);
  }
}

const A: Mark = { kind: 'prompt' };
const B: Mark = { kind: 'command' };
const C: Mark = { kind: 'output' };
const D = (exitCode: number | null): Mark => ({ kind: 'done', exitCode });

function setup() {
  const screen = new FakeScreen();
  const done: Array<CommandBlock<number>> = [];
  const tracker = new BlockTracker(screen, (block) => done.push(block));
  /** Plays a stream of text and marks, as a shell prints them. */
  const play = (...parts: Array<string | Mark>): void => {
    for (const part of parts) {
      if (typeof part === 'string') screen.write(part);
      else tracker.mark(part);
    }
  };
  return { screen, tracker, done, play };
}

describe('telling commands apart by their marks', () => {
  it('keeps the command, its output and its exit code', () => {
    const { screen, done, play } = setup();
    play(A, 'me@box ~/app\n$ ', B, 'npm test\n', C, 'FAIL one\nFAIL two\n', D(1), A, '$ ', B);
    expect(done).toHaveLength(1);
    const block = done[0]!;
    expect(block.command).toBe('npm test');
    expect(block.exitCode).toBe(1);
    expect(failed(block)).toBe(true);
    expect(block.start).toEqual({ line: 1, col: 2 });
    expect(screen.text(block.output.from, block.output.to).trim()).toBe('FAIL one\nFAIL two');
    expect(screen.text(block.output.from, block.output.to, 2).trim()).toBe('FAIL two');
  });

  it('reads each exit code: zero passes, a number fails, none is not known', () => {
    const { done, play } = setup();
    play(A, '$ ', B, 'true\n', C, D(0), A, '$ ', B, 'false\n', C, D(3), A, '$ ', B, 'odd\n', C, D(null), A);
    expect(done.map((block) => [block.command, block.exitCode, failed(block)])).toEqual([
      ['true', 0, false],
      ['false', 3, true],
      ['odd', null, false]
    ]);
  });

  it('ends a command whose D never came at the next prompt, with no exit code', () => {
    const { done, play } = setup();
    play(A, '$ ', B, 'sleep 100\n', C, '^C\n', A, '$ ', B);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ command: 'sleep 100', exitCode: null });
  });

  it('makes no block of a prompt without a command: an empty line, Ctrl+C at the prompt, a D before any command', () => {
    const { screen, done, play } = setup();
    play(D(0), A, '$ ', B, '\n', D(3), A, '$ ', B, 'half typed^C\n', D(130), A, '$ ', B);
    expect(done).toHaveLength(0);
    // A line that the shell marks as run but holds nothing is let go as well.
    play('\n', C, D(0), A, '$ ', B);
    expect(done).toHaveLength(0);
    expect(screen.released.length).toBeGreaterThan(0);
  });

  it('notes the folder the shell was in when the command was typed', () => {
    const { done, play } = setup();
    play({ kind: 'cwd', path: '/srv/app' }, A, '$ ', B, 'cd sub\n', C, D(0), { kind: 'cwd', path: '/srv/app/sub' }, A, '$ ', B, 'make\n', C, D(2));
    expect(done.map((block) => block.cwd)).toEqual(['/srv/app', '/srv/app/sub']);
  });

  it('keeps the last 50 commands and lets go of the places of older ones', () => {
    const { screen, tracker, play } = setup();
    for (let i = 0; i < MAX_BLOCKS + 5; i++) play(A, '$ ', B, `echo ${String(i)}\n`, C, `${String(i)}\n`, D(0));
    expect(tracker.blocks).toHaveLength(MAX_BLOCKS);
    expect(tracker.blocks[0]?.command).toBe('echo 5');
    expect(screen.released).toEqual(expect.arrayContaining([{ line: 0, col: 2 }]));
  });
});

describe('what is sent about a failed command', () => {
  const command = { id: 1, command: `curl -H "x-api-key: ${KEY}" https://api.example.com`, exitCode: 22, cwd: '/srv/app' };
  const output = `${Array.from({ length: 200 }, (_, i) => `line ${String(i)}`).join('\n')}\ncurl: (22) The requested URL returned error: 401\n`;

  it('keeps the end of the output, where the error is', () => {
    const tail = outputTail(output);
    expect(tail.split('\n')).toHaveLength(TAIL_LINES);
    expect(tail.endsWith('error: 401')).toBe(true);
    expect(outputTail('x'.repeat(10_000)).length).toBe(6_000);
  });

  it('asks Explain as a side question naming the shell, the system and the folder, keys covered', () => {
    const question = explainQuestion(command, output, 'Git Bash', 'win32');
    expect(question.split('\n')[0]).toMatch(/^Why did `curl -H .*` fail \(exit code 22\), and how do I fix it\?$/);
    expect(question).toContain('It ran in Git Bash on Windows, in /srv/app.');
    expect(question).toContain('error: 401');
    expect(question).not.toContain(KEY);
    expect(question.length).toBeLessThan(8_000);
    expect(explainQuestion({ ...command, exitCode: null, cwd: null }, '', 'zsh', 'darwin')).toContain('It ran in zsh on macOS.\nIt printed nothing.');
  });

  it('attaches the command as typed, its output and how it ended, keys covered', () => {
    const file = commandAttachment(command, 'oops\n');
    expect(file.name).toBe('terminal-command.txt');
    expect(file.content).toMatch(/^\$ curl -H/);
    expect(file.content).toContain('oops\n[exit code 22]');
    expect(file.content).not.toContain(KEY);
    expect(selectionAttachment(`token ${KEY}\n\n`)).toEqual({ name: 'terminal-selection.txt', content: expect.not.stringContaining(KEY) as string });
  });
});
