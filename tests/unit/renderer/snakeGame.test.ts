import { describe, expect, it } from 'vitest';
import { startGame, steerGame, stepGame, type Snake } from '../../../src/renderer/src/features/session/snakeModel';

const line = (food: { x: number; y: number }): Snake => ({ body: [{ x: 3, y: 2 }, { x: 2, y: 2 }, { x: 1, y: 2 }], food, seed: 1 });

describe('the snake you can play while a picture is made', () => {
  it('keeps going the way it was heading, and grows by one on a dot', () => {
    const game = stepGame(startGame(line({ x: 4, y: 2 })), 10, 5);
    expect(game.score).toBe(1);
    expect(game.snake.body).toHaveLength(4);
    expect(game.snake.body[0]).toEqual({ x: 4, y: 2 });
    expect(game.snake.food).not.toEqual({ x: 4, y: 2 });
  });

  it("ignores turning straight back, and ends at a wall", () => {
    let game = steerGame(startGame(line({ x: 0, y: 0 })), { x: -1, y: 0 });
    expect(game.wanted).toEqual({ x: 1, y: 0 });
    game = steerGame(game, { x: 0, y: 1 });
    game = stepGame(game, 10, 4);
    expect(game.snake.body[0]).toEqual({ x: 3, y: 3 });
    expect(stepGame(game, 10, 4).over).toBe(true);
  });
});
