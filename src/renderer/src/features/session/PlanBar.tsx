import { useState } from 'react';
import { ChevronRight, Copy, ListChecks } from 'lucide-react';
import type { ApprovedPlan } from '@shared/plans';
import type { TodoItem } from '@shared/schemas/toolDisplay';
import { Button } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { reportError, useToasts } from '../../stores/toasts';
import { Markdown } from './Markdown';
import { planBarText } from './planModel';

/**
 * The plan the session is following, above the message box: what it is
 * called and how far the tasks are. A click opens the whole plan, as the user
 * approved it.
 */
export function PlanBar({ plan, todos }: { plan: ApprovedPlan | null; todos: TodoItem[] }) {
  const [open, setOpen] = useState(false);
  if (!plan) return null;
  const { title, progress } = planBarText(plan, todos);
  const copy = (): void => {
    navigator.clipboard.writeText(plan.plan).then(
      () => useToasts.getState().push({ tone: 'success', title: 'Copied the plan' }),
      (error: unknown) => reportError("Couldn't copy to the clipboard", error)
    );
  };
  return (
    <section aria-label="Current plan" className="motion-rise rounded-lg border border-border bg-raised">
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="flex min-h-34 w-full min-w-0 items-center gap-8 rounded-lg py-2 pr-9 pl-9 text-left text-base transition-ui hover:bg-hover"
      >
        <ListChecks className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{title}</span>
        {progress ? <span className="shrink-0 text-sm text-fg-muted tabular-nums">{progress}</span> : null}
        <ChevronRight className="size-12 shrink-0 text-icon-muted" aria-hidden="true" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Plan"
          className="w-[min(720px,calc(100vw-48px))]"
          footer={
            <Button size="sm" variant="secondary" onClick={copy} leading={<Copy className="size-12" />}>
              Copy
            </Button>
          }
        >
          <Markdown text={plan.plan} variant="code" />
        </DialogContent>
      </Dialog>
    </section>
  );
}
