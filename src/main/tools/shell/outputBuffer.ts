/**
 * Keeps the head and tail of a command's output within fixed budgets so the
 * model sees the start (usually the command's framing) and the end (usually
 * the error or summary). The full output always goes to the log file.
 */
export class OutputBuffer {
  private head = '';
  private tail = '';
  private total = 0;

  constructor(
    private readonly headBudget = 10_000,
    private readonly tailBudget = 20_000
  ) {}

  append(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < this.headBudget) {
      const room = this.headBudget - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (chunk.length === 0) return;
    this.tail += chunk;
    if (this.tail.length > this.tailBudget * 2) this.tail = this.tail.slice(-this.tailBudget);
  }

  get truncated(): boolean {
    return this.total > this.headBudget + this.tailBudget;
  }

  get length(): number {
    return this.total;
  }

  text(logPath?: string): string {
    if (!this.truncated) return this.head + this.tail;
    const tail = this.tail.slice(-this.tailBudget);
    const omitted = this.total - this.head.length - tail.length;
    const where = logPath ? ` Full output: ${logPath}` : '';
    return `${this.head}\n\n… [${omitted} characters omitted.${where}]\n\n${tail}`;
  }
}

/** Removes ANSI escape sequences (colors, cursor moves) from terminal output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]/g, '');
}
