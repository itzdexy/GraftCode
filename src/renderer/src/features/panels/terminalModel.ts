import type { FileAttachment } from '@shared/schemas/messages';
import { maskSecrets } from '@shared/secrets';
import type { Mark } from '@shared/terminalMarks';

/**
 * The commands of a terminal, told apart by the marks Graft's shell integration prints (shared/terminalMarks.ts),
 * and what is sent about one that failed. Pure: the screen is reached through `Screen`, which the view answers from
 * xterm's buffer and the tests from plain lines.
 */

/** A place on the screen: a line that follows its text as older lines scroll away, and a column on it. */
export interface Spot<L> {
  line: L;
  col: number;
}

export interface Screen<L> {
  /** Where the cursor is now. */
  here(): Spot<L>;
  /** The text from one spot up to another, wrapped lines joined; only the last `lines` lines when that is given. */
  text(from: Spot<L>, to: Spot<L>, lines?: number): string;
  /** A spot that is no longer needed. */
  release(spot: Spot<L>): void;
}

export interface CommandBlock<L> {
  id: number;
  command: string;
  /** null when the shell never said: the D mark was missing, or carried no number. */
  exitCode: number | null;
  /** Where the command was typed, after the prompt. */
  start: Spot<L>;
  /** Its output, from where it began to where the command was done. */
  output: { from: Spot<L>; to: Spot<L> };
  /** The folder the shell said it was in when the command was typed. */
  cwd: string | null;
}

/** The blocks kept; an older one's places on the screen are let go. */
export const MAX_BLOCKS = 50;

export function failed(block: Pick<CommandBlock<unknown>, 'exitCode'>): boolean {
  return block.exitCode !== null && block.exitCode !== 0;
}

/**
 * Follows the marks as they arrive: A starts a prompt, B the typed command, C its output, D;code ends it. A prompt
 * whose D never came (the shell was stopped mid-command) ends that command with no exit code; a D without a C ran
 * nothing (an empty line, Ctrl+C at the prompt), and neither does a command line that is empty.
 */
export class BlockTracker<L> {
  readonly blocks: CommandBlock<L>[] = [];
  private cwd: string | null = null;
  /** Where the typed command starts, until it runs. */
  private start: Spot<L> | null = null;
  private running: { command: string; start: Spot<L>; from: Spot<L>; cwd: string | null } | null = null;
  private next = 1;

  constructor(
    private readonly screen: Screen<L>,
    private readonly onBlock: (block: CommandBlock<L>) => void = () => undefined
  ) {}

  mark(mark: Mark): void {
    switch (mark.kind) {
      case 'cwd':
        this.cwd = mark.path;
        return;
      case 'prompt':
        this.finish(null);
        this.letGo();
        return;
      case 'command':
        this.letGo();
        this.start = this.screen.here();
        return;
      case 'output': {
        if (!this.start || this.running) return;
        const from = this.screen.here();
        this.running = { command: this.screen.text(this.start, from).trim(), start: this.start, from, cwd: this.cwd };
        this.start = null;
        return;
      }
      case 'done':
        this.finish(mark.exitCode);
        this.letGo();
    }
  }

  private finish(exitCode: number | null): void {
    const running = this.running;
    this.running = null;
    if (!running) return;
    const to = this.screen.here();
    if (running.command.length === 0) {
      for (const spot of [running.start, running.from, to]) this.screen.release(spot);
      return;
    }
    const block: CommandBlock<L> = { id: this.next++, command: running.command, exitCode, start: running.start, output: { from: running.from, to }, cwd: running.cwd };
    this.blocks.push(block);
    for (const old of this.blocks.splice(0, Math.max(0, this.blocks.length - MAX_BLOCKS))) {
      for (const spot of [old.start, old.output.from, old.output.to]) this.screen.release(spot);
    }
    this.onBlock(block);
  }

  private letGo(): void {
    if (this.start) this.screen.release(this.start);
    this.start = null;
  }
}

/** The end of a failed command's output that is sent with it: the last lines say what went wrong. */
export const TAIL_LINES = 80;
const TAIL_CHARS = 6_000;
/** A command line longer than this is cut where it is quoted back. */
const COMMAND_CHARS = 500;

export function outputTail(output: string): string {
  const tail = output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
  return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
}

/** A failed command as the panel offers it: what was typed, how it ended, where, and its output read when wanted. */
export interface FailedCommand {
  id: number;
  command: string;
  exitCode: number | null;
  cwd: string | null;
  output(): string;
}

const SYSTEMS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

function ended(exitCode: number | null): string {
  return exitCode === null ? '' : ` (exit code ${String(exitCode)})`;
}

/** The side question Explain asks about a failed command. It goes to a model, so keys and passwords are covered. */
export function explainQuestion(command: Omit<FailedCommand, 'output'>, output: string, shell: string, platform: string): string {
  const typed = command.command.length > COMMAND_CHARS ? `${command.command.slice(0, COMMAND_CHARS)}…` : command.command;
  const tail = outputTail(output);
  return maskSecrets(
    [
      `Why did \`${typed}\` fail${ended(command.exitCode)}, and how do I fix it?`,
      `It ran in ${shell} on ${SYSTEMS[platform] ?? platform}${command.cwd ? `, in ${command.cwd}` : ''}.`,
      tail.length > 0 ? `The end of its output:\n\`\`\`\n${tail}\n\`\`\`` : 'It printed nothing.'
    ].join('\n')
  );
}

/** What "Add to message" attaches for a command: the line as typed at a prompt, its output, and how it ended. */
export function commandAttachment(command: Omit<FailedCommand, 'output'>, output: string): FileAttachment {
  const parts = [`$ ${command.command}`, outputTail(output), command.exitCode === null ? '' : `[exit code ${String(command.exitCode)}]`];
  return { name: 'terminal-command.txt', content: maskSecrets(parts.filter((part) => part.length > 0).join('\n')) };
}

/** What "Add to message" attaches for text selected in the terminal. */
export function selectionAttachment(text: string): FileAttachment {
  return { name: 'terminal-selection.txt', content: maskSecrets(text.trimEnd()).slice(0, 200_000) };
}
