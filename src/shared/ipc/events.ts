import { z } from 'zod';
import { AgentEventSchema } from '../schemas/agentEvents';
import { AppSettingsSchema } from '../schemas/appSettings';
import { ProviderSummarySchema } from '../schemas/models';
import { BrowserStateSchema } from '../schemas/panels';
import { SessionSummarySchema } from '../schemas/sessions';
import { UpdateStateSchema } from '../schemas/system';

/**
 * Main → renderer push events. One IPC channel carries this discriminated
 * union; main validates each event against the schema in development.
 */
export const GraftEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('init:progress'),
    step: z.string(),
    label: z.string(),
    done: z.number().int(),
    total: z.number().int()
  }),
  z.object({ type: z.literal('settings:changed'), settings: AppSettingsSchema }),
  z.object({ type: z.literal('providers:changed'), providers: z.array(ProviderSummarySchema) }),
  z.object({ type: z.literal('session:event'), sessionId: z.string(), event: AgentEventSchema }),
  z.object({ type: z.literal('session:summary'), summary: SessionSummarySchema }),
  z.object({ type: z.literal('session:removed'), sessionId: z.string() }),
  z.object({ type: z.literal('app:navigate'), sessionId: z.string() }),
  z.object({ type: z.literal('pty:data'), id: z.string(), data: z.string(), offset: z.number().int() }),
  z.object({ type: z.literal('pty:exit'), id: z.string(), exitCode: z.number().int() }),
  z.object({ type: z.literal('shells:changed'), sessionId: z.string() }),
  z.object({ type: z.literal('browser:state'), state: BrowserStateSchema }),
  z.object({ type: z.literal('mcp:changed') }),
  z.object({ type: z.literal('schedules:changed') }),
  z.object({ type: z.literal('updates:state'), state: UpdateStateSchema })
]);

export type GraftEvent = z.infer<typeof GraftEventSchema>;
export type GraftEventType = GraftEvent['type'];
