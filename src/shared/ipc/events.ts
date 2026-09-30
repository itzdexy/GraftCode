import { z } from 'zod';

/**
 * Main → renderer push events. One IPC channel carries this discriminated
 * union; the schema is checked in main before sending in development builds.
 */
export const GraftEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('window:maximized'), maximized: z.boolean() })
]);

export type GraftEvent = z.infer<typeof GraftEventSchema>;
export type GraftEventType = GraftEvent['type'];
