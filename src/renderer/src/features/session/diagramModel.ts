import type { DiagramSource } from '@shared/schemas/diagrams';
import type { ToolCall } from './transcriptModel';

/**
 * The diagrams a turn drew, and how one is fitted into a card or a viewer.
 * Pure, so it is unit-tested without a DOM.
 */

/** A diagram to show: where its file is, the file's name, and the title and size the tool that wrote it recorded. */
export interface MadeDiagram {
  source: DiagramSource;
  name: string;
  title: string;
  width: number;
  height: number;
}

/** A diagram in a card is never taller than this. */
export const CARD_MAX_HEIGHT = 520;
/** A card draws this many diagrams; the rest wait behind "Show more". */
export const CARD_MAX_SHOWN = 6;
/** A page changes its mind about its size at most this often before the card stops listening (a page sized by the frame's own height would grow for ever). */
export const MAX_SIZE_REPORTS = 4;

/** The room a diagram's page keeps on its two sides. */
const PAGE_MARGIN = 64;
const MIN_FRAME_WIDTH = 640;
const MIN_REPORTED = 100;
const MAX_REPORTED = 20_000;

/**
 * The diagrams of a turn's tool calls: one for each file, in the order the
 * files were first written, each as its newest change left it. A page whose
 * newest change is no diagram any more is none.
 */
export function madeDiagrams(calls: ToolCall[]): MadeDiagram[] {
  const byFile = new Map<string, MadeDiagram | null>();
  for (const call of calls) {
    const d = call.result?.display;
    if (d?.kind !== 'edit' || call.result?.isError) continue;
    const name = d.path.split(/[\\/]/).pop() ?? d.path;
    byFile.set(`project:${d.path}`, d.diagram ? { source: { kind: 'project', path: d.path }, name, ...d.diagram } : null);
  }
  return [...byFile.values()].filter((diagram): diagram is MadeDiagram => diagram !== null);
}

/** A name for a diagram's place among its siblings. */
export function sourceKey(source: DiagramSource): string {
  return source.kind === 'project' ? `project:${source.path}` : `chat:${source.name}`;
}

/** How wide the frame is made, so the page draws its diagram at the diagram's own size. */
export function frameWidth(width: number): number {
  return Math.max(width + PAGE_MARGIN, MIN_FRAME_WIDTH);
}

/** How much a frame is scaled to fit a box of some width and at most some height. Never enlarged. */
export function fitScale(frame: { width: number; height: number }, box: { width: number; maxHeight: number }): number {
  return Math.min(1, box.width / frame.width, box.maxHeight / frame.height);
}

/**
 * The size a page reported, when the message is such a report. Anything a
 * page posts reaches this, so it takes only finite numbers and keeps them
 * within what a page can sensibly be.
 */
export function sizeFromMessage(data: unknown): { width: number; height: number } | null {
  if (typeof data !== 'object' || data === null) return null;
  const report = (data as { graftPreview?: unknown }).graftPreview;
  if (typeof report !== 'object' || report === null) return null;
  const { width, height } = report as { width?: unknown; height?: unknown };
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const kept = (value: number): number => Math.min(MAX_REPORTED, Math.max(MIN_REPORTED, Math.round(value)));
  return { width: kept(width), height: kept(height) };
}

/** What a card says in place of a diagram it cannot show. */
export function previewProblem(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (code === 'not_found') return 'This file was moved or deleted.';
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/** The zoom levels of the viewer, after "Fit". */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2] as const;

/** The next level up or down from where the viewer is; `fit` is the scale "Fit" has right now. Stays at the ends. */
export function nextZoom(current: number | 'fit', fit: number, direction: 1 | -1): number {
  const from = current === 'fit' ? fit : current;
  const next = direction === 1 ? ZOOM_STEPS.find((step) => step > from + 1e-6) : ZOOM_STEPS.findLast((step) => step < from - 1e-6);
  return next ?? (direction === 1 ? ZOOM_STEPS[4] : ZOOM_STEPS[0]);
}
