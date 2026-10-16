import { create } from 'zustand';
import { errorText, invoke } from '../lib/ipc';
import { logError } from '../lib/log';

/** A side question (/btw) and its answer. It lives in the window only: the conversation never holds it. */
export interface Aside {
  id: string;
  question: string;
  /** What has been heard of the answer so far; the whole answer once `status` is "answered". */
  answer: string;
  status: 'asking' | 'answered' | 'failed';
  error: string | null;
}

/** A session shows this many side questions; an older one makes way for a new one. */
export const MAX_ASIDES = 3;

/** The question in "/btw question": empty when none was typed, null when the text is not that command. */
export function asideQuestion(text: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? (match[1] ?? '').trim() : null;
}

interface AsidesState {
  bySession: Record<string, Aside[]>;
  /** Asks the session a side question; its answer fills in as it arrives. */
  ask: (sessionId: string, question: string) => void;
  /** More of an answer (an `aside` event). Ignored for a question that is no longer shown. */
  hear: (sessionId: string, askId: string, text: string) => void;
  dismiss: (sessionId: string, askId: string) => void;
  /** Drops the questions of a session that was removed. */
  forget: (sessionId: string) => void;
}

function stopAsking(sessionId: string, aside: Aside): void {
  if (aside.status !== 'asking') return;
  invoke('sessions:cancelAside', { id: sessionId, askId: aside.id }).catch((error: unknown) => logError('Could not cancel a side question', error));
}

export const useAsides = create<AsidesState>((set, get) => {
  const change = (sessionId: string, askId: string, to: (aside: Aside) => Aside): void => {
    const list = get().bySession[sessionId];
    if (!list?.some((a) => a.id === askId)) return;
    set({ bySession: { ...get().bySession, [sessionId]: list.map((a) => (a.id === askId ? to(a) : a)) } });
  };
  return {
    bySession: {},
    ask(sessionId, question) {
      const aside: Aside = { id: crypto.randomUUID(), question, answer: '', status: 'asking', error: null };
      const all = [...(get().bySession[sessionId] ?? []), aside];
      for (const dropped of all.slice(0, -MAX_ASIDES)) stopAsking(sessionId, dropped);
      set({ bySession: { ...get().bySession, [sessionId]: all.slice(-MAX_ASIDES) } });
      invoke('sessions:aside', { id: sessionId, askId: aside.id, question }).then(
        ({ text }) => change(sessionId, aside.id, (a) => ({ ...a, status: 'answered', answer: text })),
        (error: unknown) => change(sessionId, aside.id, (a) => ({ ...a, status: 'failed', error: errorText(error) }))
      );
    },
    hear(sessionId, askId, text) {
      change(sessionId, askId, (a) => (a.status === 'asking' ? { ...a, answer: a.answer + text } : a));
    },
    dismiss(sessionId, askId) {
      const list = get().bySession[sessionId] ?? [];
      const aside = list.find((a) => a.id === askId);
      if (!aside) return;
      stopAsking(sessionId, aside);
      set({ bySession: { ...get().bySession, [sessionId]: list.filter((a) => a.id !== askId) } });
    },
    forget(sessionId) {
      const { [sessionId]: _gone, ...rest } = get().bySession;
      set({ bySession: rest });
    }
  };
});
