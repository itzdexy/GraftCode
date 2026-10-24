/**
 * The line of dots that wanders the grid while a picture is being made: it
 * walks to a dot, a new dot appears somewhere else, and it sets off again.
 * Pure and seeded, so the same grid always plays the same walk.
 */

export interface Cell {
  x: number;
  y: number;
}

export interface Snake {
  /** Head first. */
  body: Cell[];
  food: Cell;
  seed: number;
}

export const SNAKE_LENGTH = 6;

function nextSeed(seed: number): number {
  return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}

function same(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

/** A cell the line is not on. */
function place(seed: number, cols: number, rows: number, avoid: Cell[]): { cell: Cell; seed: number } {
  let s = seed;
  for (let tries = 0; tries < 24; tries++) {
    s = nextSeed(s);
    const x = (s >>> 8) % cols;
    s = nextSeed(s);
    const y = (s >>> 8) % rows;
    if (!avoid.some((c) => same(c, { x, y }))) return { cell: { x, y }, seed: s };
  }
  return { cell: { x: 0, y: 0 }, seed: s };
}

export function startSnake(cols: number, rows: number, seed = 7): Snake {
  const y = Math.floor(rows / 2);
  const head = Math.max(SNAKE_LENGTH - 1, Math.floor(cols / 3));
  const body = Array.from({ length: SNAKE_LENGTH }, (_, i) => ({ x: head - i, y }));
  const first = place(seed, cols, rows, body);
  return { body, food: first.cell, seed: first.seed };
}

/** One step towards the dot: along the row first, then the column, never back onto its own neck. */
export function stepSnake(snake: Snake, cols: number, rows: number): Snake {
  const head = snake.body[0];
  if (!head) return startSnake(cols, rows, snake.seed);
  const neck = snake.body[1];
  const dx = Math.sign(snake.food.x - head.x);
  const dy = Math.sign(snake.food.y - head.y);
  const aside = dy !== 0 ? dy : head.y + 1 < rows ? 1 : -1;
  let next: Cell = dx !== 0 ? { x: head.x + dx, y: head.y } : { x: head.x, y: head.y + dy };
  if (neck && same(next, neck)) next = dx !== 0 ? { x: head.x, y: head.y + aside } : { x: head.x + (head.x + 1 < cols ? 1 : -1), y: head.y };
  const body = [next, ...snake.body].slice(0, SNAKE_LENGTH);
  if (!same(next, snake.food)) return { body, food: snake.food, seed: snake.seed };
  const placed = place(snake.seed, cols, rows, body);
  return { body, food: placed.cell, seed: placed.seed };
}
