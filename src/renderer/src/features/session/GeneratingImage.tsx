import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { reducedMotion } from '../../lib/motion';
import { startGame, startSnake, steerGame, stepGame, stepSnake, type Cell, type SnakeGame } from './snakeModel';
import { durationText } from './transcriptModel';

const COLS = 22;
const ROWS = 11;
const CELL = 12;
const STEP_MS = 120;

const KEYS: Record<string, Cell> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  w: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  a: { x: -1, y: 0 },
  d: { x: 1, y: 0 }
};

/** The best score of this run of Graft, across pictures. */
let best = 0;

/**
 * A picture being made: a grid of dots on which a line of brighter dots
 * walks from one leaf-green dot to the next. Click it or press an arrow key
 * on it and it is a game of Snake until the picture arrives. The line above
 * it (the block's own) says what is being made; the corner says what the
 * engine last reported, how long it has been, or the score. With reduced
 * motion the grid holds still until someone plays.
 */
export function GeneratingImage({ label, note }: { label: string; note: string | null }) {
  const pattern = useId();
  const [started] = useState(() => Date.now());
  // The walk and the clock move together: one update per step.
  const [frame, setFrame] = useState(() => ({ snake: startSnake(COLS, ROWS), now: started }));
  const [game, setGame] = useState<SnakeGame | null>(null);
  const [moving] = useState(() => !reducedMotion());
  const playing = game !== null && !game.over;
  useEffect(() => {
    if (!moving && !playing) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      if (playing) setGame((g) => (g ? stepGame(g, COLS, ROWS) : g));
      else setFrame((f) => ({ snake: stepSnake(f.snake, COLS, ROWS), now: Date.now() }));
    }, STEP_MS);
    return () => clearInterval(timer);
  }, [moving, playing]);
  useEffect(() => {
    if (game) best = Math.max(best, game.score);
  }, [game]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.currentTarget.blur();
      setGame(null);
      return;
    }
    if ((event.key === ' ' || event.key === 'Enter') && (!game || game.over)) {
      event.preventDefault();
      setGame(startGame(game ? startSnake(COLS, ROWS, game.snake.seed) : frame.snake));
      return;
    }
    const dir = KEYS[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (!dir) return;
    event.preventDefault();
    setGame((g) => (g && !g.over ? steerGame(g, dir) : startGame(g ? startSnake(COLS, ROWS, g.snake.seed) : frame.snake, dir)));
  };

  const snake = game?.snake ?? frame.snake;
  const at = (n: number): number => n * CELL + CELL / 2;
  const corner = game
    ? game.over
      ? `Game over · ${String(game.score)} · Space to play again`
      : `Score ${String(game.score)}${best > game.score ? ` · best ${String(best)}` : ''}`
    : (note ?? (moving ? durationText(frame.now - started) : null));
  return (
    <div role="status" aria-label={label} className="flex px-4 py-4">
      <div
        tabIndex={0}
        role="application"
        aria-label="Snake, while the picture is made. Arrow keys or W A S D to play, Space to start again, Escape to stop."
        onKeyDown={onKeyDown}
        onClick={(event) => event.currentTarget.focus()}
        className="graft-dotgrid group/snake relative cursor-pointer overflow-hidden rounded-md border border-border-subtle bg-sunken outline-none transition-ui focus-visible:border-accent focus:border-accent"
      >
        <svg width={COLS * CELL} height={ROWS * CELL} viewBox={`0 0 ${String(COLS * CELL)} ${String(ROWS * CELL)}`} aria-hidden="true" className="relative block max-w-full">
          <defs>
            <pattern id={pattern} width={CELL} height={CELL} patternUnits="userSpaceOnUse">
              <circle cx={CELL / 2} cy={CELL / 2} r={0.9} fill="var(--g-text-faint)" opacity={0.55} />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${pattern})`} />
          <circle className="graft-dotgrid__food" cx={at(snake.food.x)} cy={at(snake.food.y)} r={3.2} fill="var(--g-accent)" />
          {snake.body.map((cell, i) => (
            <circle
              key={i}
              cx={at(cell.x)}
              cy={at(cell.y)}
              r={i === 0 ? 3.6 : 3}
              fill={game?.over ? 'var(--g-danger)' : 'var(--g-text-strong)'}
              opacity={Math.max(0.25, 1 - i * (game ? 0.04 : 0.15))}
            />
          ))}
        </svg>
        {game ? null : (
          <span className="pointer-events-none absolute top-6 left-6 rounded-full bg-control px-8 py-px text-2xs text-fg-secondary opacity-0 transition-ui group-hover/snake:opacity-100 group-focus/snake:opacity-100" aria-hidden="true">
            Arrow keys to play
          </span>
        )}
        {corner ? (
          <span className="absolute right-6 bottom-6 max-w-[80%] truncate rounded-full bg-control px-8 py-px text-2xs text-fg-secondary tabular-nums" aria-hidden="true">
            {corner}
          </span>
        ) : null}
      </div>
    </div>
  );
}
