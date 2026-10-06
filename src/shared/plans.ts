import type { StoredMessage } from './schemas/messages';
import type { TodoItem } from './schemas/toolDisplay';

/**
 * The plan a session is following: the newest plan the user approved, as they
 * approved it, among the messages since the last /clear. It is read from the
 * conversation and kept nowhere else, so a rewind to before the approval takes
 * the plan with it, and a plan that was turned down changes nothing.
 */
export interface ApprovedPlan {
  plan: string;
  /** The message that holds the approval. */
  messageId: string;
  at: number;
}

export function currentPlan(messages: StoredMessage[]): ApprovedPlan | null {
  const newestFirst = [...messages].sort((a, b) => b.seq - a.seq);
  for (const message of newestFirst) {
    // Nothing before a /clear is current any more.
    if (message.meta.cleared) return null;
    for (const block of [...message.content].reverse()) {
      if (block.type === 'tool_result' && block.display?.kind === 'plan' && block.display.approved) {
        return { plan: block.display.plan, messageId: message.id, at: message.createdAt };
      }
    }
  }
  return null;
}

/** What a plan is called: its first heading or first line, without Markdown marks, in at most 60 characters. */
export function planTitle(plan: string): string {
  const line =
    plan
      .split('\n')
      .map((each) => each.trim())
      .find((each) => each.length > 0) ?? '';
  const title =
    line
      .replace(/^#+\s*/, '')
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .replace(/[*_`]/g, '')
      .trim() || 'Plan';
  return title.length > 60 ? `${title.slice(0, 59)}…` : title;
}

/** How far a session's tasks are; null when it has none. */
export function planProgress(todos: TodoItem[]): { done: number; total: number } | null {
  return todos.length === 0 ? null : { done: todos.filter((todo) => todo.status === 'completed').length, total: todos.length };
}
