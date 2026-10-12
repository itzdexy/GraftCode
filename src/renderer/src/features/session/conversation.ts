import { createContext } from 'react';

/** The conversation a piece of a reply is drawn in, and how that piece can act on it. */
export interface Conversation {
  sessionId: string;
  kind: 'code' | 'chat';
  /** The conversation can save files, so it can be asked for a diagram. */
  canDraw: boolean;
  /** Sends a message as if it had been typed. */
  send: (text: string) => void;
}

/** Null outside a transcript: there, a file name is only a name and a code block only shows its code. */
export const ConversationContext = createContext<Conversation | null>(null);
