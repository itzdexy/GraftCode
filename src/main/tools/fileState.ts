import fs from 'node:fs';
import { pathKeyFor } from './paths';

interface Seen {
  mtimeMs: number;
  size: number;
}

export type FreshCheck = { ok: true } | { ok: false; reason: 'not-read' | 'modified' | 'missing' };

/**
 * Remembers which files the agent has read (or written) in this session and
 * their stat at that time, so edits require a prior read and refuse to
 * clobber files changed underneath the agent.
 */
export class FileStateTracker {
  private readonly seen = new Map<string, Seen>();
  private readonly touched = new Set<string>();

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  private key(p: string): string {
    return pathKeyFor(p, this.platform);
  }

  record(p: string): void {
    const stat = fs.statSync(p);
    this.seen.set(this.key(p), { mtimeMs: stat.mtimeMs, size: stat.size });
    this.touched.add(p);
  }

  check(p: string): FreshCheck {
    const seen = this.seen.get(this.key(p));
    if (!seen) return { ok: false, reason: 'not-read' };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      return { ok: false, reason: 'missing' };
    }
    if (stat.mtimeMs !== seen.mtimeMs || stat.size !== seen.size) return { ok: false, reason: 'modified' };
    return { ok: true };
  }

  forget(p: string): void {
    this.seen.delete(this.key(p));
  }

  /** Files read or written this session (for compaction summaries). */
  touchedFiles(): string[] {
    return [...this.touched];
  }

  clear(): void {
    this.seen.clear();
  }
}
