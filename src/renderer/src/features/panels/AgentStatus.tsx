import { Check, CircleDashed, Minus, RotateCw, Square, X } from 'lucide-react';
import type { AgentRunStatus } from '@shared/schemas/agentRuns';
import { Ring } from '../../components/ContextRing';

export const AGENT_STATUS_LABEL: Record<AgentRunStatus, string> = {
  queued: 'Waiting',
  running: 'Working',
  retrying: 'Retrying',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Stopped'
};

export function isAgentStatus(status: string): status is AgentRunStatus {
  return status in AGENT_STATUS_LABEL;
}

/** The mark in front of an agent: how it is doing, at a glance. Decorative; the label says it in words. */
export function AgentStatusGlyph({ status }: { status: AgentRunStatus }) {
  switch (status) {
    case 'running':
      return <Ring value={0} size={12} spinning />;
    case 'retrying':
      return <RotateCw className="size-12 shrink-0 text-amber-fg" aria-hidden="true" />;
    case 'done':
      return <Check className="size-12 shrink-0 text-success" aria-hidden="true" />;
    case 'failed':
      return <X className="size-12 shrink-0 text-danger" aria-hidden="true" />;
    case 'skipped':
      return <Minus className="size-12 shrink-0 text-icon-muted" aria-hidden="true" />;
    case 'cancelled':
      return <Square className="size-10 shrink-0 text-icon-muted" aria-hidden="true" />;
    case 'queued':
      return <CircleDashed className="size-12 shrink-0 text-icon-muted" aria-hidden="true" />;
  }
}
