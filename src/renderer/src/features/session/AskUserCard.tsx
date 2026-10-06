import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, ChevronUp, X } from 'lucide-react';
import type { QuestionAnswer, QuestionRequest } from '@shared/schemas/permissions';
import { Kbd } from '../../components/Badge';
import { Button, IconButton } from '../../components/Button';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { reportError } from '../../stores/toasts';

interface Draft {
  selected: string[];
  other: string;
  otherChosen: boolean;
}

const EMPTY: Draft = { selected: [], other: '', otherChosen: false };

function toAnswer(draft: Draft): QuestionAnswer {
  const other = draft.otherChosen ? draft.other.trim() : '';
  if (draft.selected.length === 0 && other.length === 0) return null;
  return { selected: draft.selected, ...(other ? { other } : {}) };
}

/**
 * The agent's AskUserQuestion, rendered above the composer: one question at a
 * time with a 1/N counter, numbered options (keys 1–9), "Other" with free
 * text, Skip / Next, collapse and dismiss.
 */
export function AskUserCard({ sessionId, request }: { sessionId: string; request: QuestionRequest }) {
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>(() => request.questions.map(() => EMPTY));
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const question = request.questions[index];
  const draft = drafts[index] ?? EMPTY;
  const total = request.questions.length;
  const last = index === total - 1;

  useEffect(() => {
    // Don't pull focus out of a text field the user is typing in.
    const active = document.activeElement;
    if ((active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && !cardRef.current?.contains(active)) return;
    cardRef.current?.querySelector<HTMLElement>('[data-option]')?.focus();
  }, [index]);

  if (!question) return null;

  const update = (next: Partial<Draft>): void => {
    setDrafts((all) => all.map((d, i) => (i === index ? { ...d, ...next } : d)));
  };

  const toggle = (label: string): void => {
    if (question.multiSelect) {
      update({ selected: draft.selected.includes(label) ? draft.selected.filter((l) => l !== label) : [...draft.selected, label] });
    } else {
      update({ selected: [label], otherChosen: false });
    }
  };

  const chooseOther = (): void => {
    if (question.multiSelect) update({ otherChosen: !draft.otherChosen });
    else update({ selected: [], otherChosen: true });
    requestAnimationFrame(() => otherRef.current?.focus());
  };

  const send = async (answers: QuestionAnswer[], dismissed: boolean): Promise<void> => {
    setBusy(true);
    try {
      await invoke('sessions:answerQuestion', { sessionId, requestId: request.id, answers, ...(dismissed ? { dismissed: true } : {}) });
    } catch (error) {
      reportError("Couldn't send your answer", error);
      setBusy(false);
    }
  };

  const advance = (answer: QuestionAnswer): void => {
    const answers = drafts.map((d, i) => (i === index ? answer : toAnswer(d)));
    if (last) void send(answers, false);
    else {
      setDrafts((all) => all.map((d, i) => (i === index && answer === null ? EMPTY : d)));
      setIndex(index + 1);
    }
  };

  const answer = toAnswer(draft);
  const optionCount = question.options.length + 1;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLInputElement) {
      if (event.key === 'Enter' && answer) {
        event.preventDefault();
        advance(answer);
      }
      return;
    }
    const n = Number(event.key);
    if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, optionCount)) {
      event.preventDefault();
      if (n === optionCount) chooseOther();
      else {
        const option = question.options[n - 1];
        if (option) toggle(option.label);
      }
    } else if (event.key === 'Enter' && answer && !(event.target instanceof HTMLButtonElement && event.target.dataset.option !== undefined)) {
      event.preventDefault();
      advance(answer);
    }
  };

  return (
    <div
      ref={cardRef}
      role="group"
      aria-label={`Question ${index + 1} of ${total}`}
      onKeyDown={onKeyDown}
      className="motion-rise rounded-lg border border-border-card bg-sunken px-12 pt-10 pb-12"
    >
      <div className="flex items-center gap-8">
        <span className="inline-flex h-18 shrink-0 items-center rounded-xs bg-counter-bg px-6 text-xs font-medium text-counter-fg">
          {index + 1}/{total}
        </span>
        <p className="min-w-0 flex-1 text-md font-medium text-fg-strong">{question.question}</p>
        <IconButton label={collapsed ? 'Expand question' : 'Collapse question'} size="xs" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <ChevronUp className="size-14" /> : <ChevronDown className="size-14" />}
        </IconButton>
        <IconButton label="Dismiss question" size="xs" disabled={busy} onClick={() => void send(request.questions.map(() => null), true)}>
          <X className="size-14" />
        </IconButton>
      </div>
      {collapsed ? null : (
        <>
          <div role={question.multiSelect ? 'group' : 'radiogroup'} aria-label="Options" className="mt-10 flex flex-col gap-4">
            {question.options.map((option, i) => {
              const selected = draft.selected.includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  data-option
                  role={question.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={selected}
                  onClick={() => toggle(option.label)}
                  onDoubleClick={() => {
                    if (!question.multiSelect) advance({ selected: [option.label] });
                  }}
                  className={cn(
                    'flex items-start gap-10 rounded-xs border bg-inset px-8 py-6 text-left transition-ui',
                    selected ? 'border-border-strong' : 'border-transparent hover:border-border'
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-base text-fg">{option.label}</span>
                    {option.description ? <span className="mt-2 block text-sm text-fg-muted">{option.description}</span> : null}
                  </span>
                  {selected ? <Check className="mt-1 size-14 shrink-0 text-blue" aria-hidden="true" /> : null}
                  {i < 9 ? <Kbd className="mt-1">{i + 1}</Kbd> : null}
                </button>
              );
            })}
            <div className={cn('flex flex-col gap-6 rounded-xs border bg-inset px-8 py-6', draft.otherChosen ? 'border-border-strong' : 'border-transparent')}>
              <button
                type="button"
                data-option
                role={question.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={draft.otherChosen}
                onClick={chooseOther}
                className="flex items-center gap-10 text-left"
              >
                <span className="min-w-0 flex-1 text-base text-fg">Other</span>
                {optionCount <= 9 ? <Kbd>{optionCount}</Kbd> : null}
              </button>
              <input
                ref={otherRef}
                value={draft.other}
                aria-label="Your own answer"
                placeholder="Type your own answer here"
                onFocus={() => {
                  if (!draft.otherChosen) update(question.multiSelect ? { otherChosen: true } : { selected: [], otherChosen: true });
                }}
                onChange={(e) => update({ other: e.target.value, otherChosen: true, ...(question.multiSelect ? {} : { selected: [] }) })}
                className="h-[var(--g-ask-input-height)] w-full rounded-sm border border-input-border bg-input px-8 text-base text-fg outline-none focus:border-border-strong"
              />
            </div>
          </div>
          <div className="mt-10 flex justify-end gap-6">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => advance(null)}>
              Skip
            </Button>
            <Button size="sm" variant="primary" disabled={busy || answer === null} onClick={() => answer && advance(answer)}>
              {last ? 'Submit' : 'Next'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
