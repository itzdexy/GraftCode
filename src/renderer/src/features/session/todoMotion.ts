/** Which tasks of a list changed state since the list before it (pure; unit-tested). */

import type { TodoItem } from '@shared/schemas/toolDisplay';

/** What a task is told apart by: its id, or its place in the list when it has none. */
export function todoKey(todo: TodoItem, index: number): string {
  return todo.id || String(index);
}

/**
 * The tasks whose state differs from the list before. None when there was no
 * list before; a task that is new to the list is not one: it did not change,
 * it arrived. A model that sends its tasks without ids is given new ones with
 * every list, so a task the list before does not know by its key is looked
 * for there by its words.
 */
export function changedTodos(previous: readonly TodoItem[] | null, todos: readonly TodoItem[]): string[] {
  if (previous === null) return [];
  const byKey = new Map(previous.map((todo, index) => [todoKey(todo, index), todo.status]));
  const byWords = new Map(previous.map((todo) => [todo.content, todo.status]));
  return todos.flatMap((todo, index) => {
    const key = todoKey(todo, index);
    const was = byKey.get(key) ?? byWords.get(todo.content);
    return was !== undefined && was !== todo.status ? [key] : [];
  });
}
