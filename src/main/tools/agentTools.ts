import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TodoItem } from '@shared/schemas/toolDisplay';
import { errorResult, textResult, type ToolDefinition } from './types';

export const TodoWriteInput = z.object({
  todos: z
    .array(
      z.object({
        id: z.string().max(100).optional(),
        content: z.string().min(1).max(500).describe('Imperative description, e.g. "Add input validation".'),
        activeForm: z.string().max(500).optional().describe('Present-tense form shown while in progress, e.g. "Adding input validation".'),
        status: z.enum(['pending', 'in_progress', 'completed'])
      })
    )
    .max(100)
});
export type TodoWriteInput = z.infer<typeof TodoWriteInput>;

export const todoWriteTool: ToolDefinition<TodoWriteInput> = {
  name: 'TodoWrite',
  description: [
    'Replace the task list shown to the user. Use it for work with three or more steps:',
    'mark one item in_progress before starting it and completed as soon as it is done.',
    'Send the full list every time.'
  ].join(' '),
  input: TodoWriteInput,
  permissionClass: 'none',
  concurrencySafe: () => false,
  timeoutMs: 5_000,
  describe: (input) => Promise.resolve({ summary: `Updated the task list (${input.todos.length} items)` }),
  execute(input, ctx) {
    const todos: TodoItem[] = input.todos.map((t) => ({
      id: t.id ?? randomUUID().slice(0, 8),
      content: t.content,
      status: t.status,
      ...(t.activeForm ? { activeForm: t.activeForm } : {})
    }));
    ctx.todos.set(todos);
    const count = (s: TodoItem['status']): number => todos.filter((t) => t.status === s).length;
    const note = count('in_progress') > 1 ? ' Keep only one item in progress at a time.' : '';
    return Promise.resolve(
      textResult(
        `Task list updated: ${count('completed')} done, ${count('in_progress')} in progress, ${count('pending')} pending.${note}`,
        { kind: 'todos', todos }
      )
    );
  }
};

export const AskUserInput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1).max(500),
        header: z.string().max(40).optional().describe('Very short label for the question.'),
        options: z
          .array(z.object({ label: z.string().min(1).max(120), description: z.string().max(300).optional() }))
          .min(2)
          .max(9),
        multiSelect: z.boolean().optional()
      })
    )
    .min(1)
    .max(4)
});
export type AskUserInput = z.infer<typeof AskUserInput>;

export const askUserTool: ToolDefinition<AskUserInput> = {
  name: 'AskUserQuestion',
  description: [
    'Ask the user one to four multiple-choice questions when a decision is genuinely theirs',
    '(requirements, preferences, trade-offs). Offer 2–9 concrete options; the user can also write their own answer.',
    'Put the recommended option first and say so in its label.'
  ].join(' '),
  input: AskUserInput,
  permissionClass: 'none',
  concurrencySafe: () => false,
  timeoutMs: 24 * 60 * 60_000,
  describe: (input) => Promise.resolve({ summary: `Asked ${input.questions.length === 1 ? 'a question' : `${input.questions.length} questions`}` }),
  async execute(input, ctx) {
    const questions = input.questions.map((q) => ({
      question: q.question,
      ...(q.header ? { header: q.header } : {}),
      options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
      multiSelect: q.multiSelect === true
    }));
    const answers = await ctx.askUser(questions);
    if (answers === null) {
      return textResult('The user closed the questions without answering. Continue with your best judgment or ask in plain text.', {
        kind: 'question',
        answers: questions.map((q) => ({ question: q.question, answer: null }))
      });
    }
    const pairs = questions.map((q, i) => {
      const a = answers[i];
      if (!a) return { question: q.question, answer: null };
      const parts = [...a.selected, ...(a.other ? [a.other] : [])];
      return { question: q.question, answer: parts.length > 0 ? parts.join('; ') : null };
    });
    const text = pairs.map((p) => `Q: ${p.question}\nA: ${p.answer ?? '(skipped)'}`).join('\n\n');
    return textResult(text, { kind: 'question', answers: pairs });
  }
};

export const ExitPlanModeInput = z.object({
  plan: z.string().min(1).max(50_000).describe('The implementation plan, in Markdown.')
});
export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInput>;

export const exitPlanModeTool: ToolDefinition<ExitPlanModeInput> = {
  name: 'ExitPlanMode',
  description: [
    'In plan mode, present your finished plan for approval. Call it only after researching;',
    'if approved you may start making changes, otherwise revise the plan using the feedback.'
  ].join(' '),
  input: ExitPlanModeInput,
  permissionClass: 'none',
  concurrencySafe: () => false,
  timeoutMs: 24 * 60 * 60_000,
  describe: () => Promise.resolve({ summary: 'Presented a plan' }),
  async execute(input, ctx) {
    const { approved, feedback } = await ctx.approvePlan(input.plan);
    const text = approved
      ? 'The user approved the plan. Plan mode is off; carry out the plan now.'
      : `The user did not approve the plan.${feedback ? ` Feedback: ${feedback}` : ''} Stay in plan mode and revise it.`;
    return textResult(text, { kind: 'plan', plan: input.plan, approved, feedback });
  }
};

export const TaskInput = z.object({
  description: z.string().min(1).max(120).describe('Three to eight words naming the sub-task.'),
  prompt: z.string().min(1).max(20_000).describe('Complete, self-contained instructions; the sub-agent sees nothing else.'),
  subagent_type: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      '"explore" is read-only research (fast, parallel-safe); "general" (default) can also edit and run commands; or the name of a custom agent from the system prompt.'
    )
});
export type TaskInput = z.infer<typeof TaskInput>;

export const taskTool: ToolDefinition<TaskInput> = {
  name: 'Task',
  description: [
    'Delegate a self-contained sub-task to a sub-agent with its own fresh context, e.g. a broad codebase search',
    'or an independent change. It returns one final report. Run several explore tasks in one response to parallelize.'
  ].join(' '),
  input: TaskInput,
  permissionClass: 'none',
  concurrencySafe: (input) => input.subagent_type === 'explore',
  timeoutMs: 60 * 60_000,
  describe: (input) => Promise.resolve({ summary: `Delegated: ${input.description}` }),
  async execute(input, ctx) {
    const type = (input.subagent_type ?? 'general').trim().toLowerCase();
    const { text, toolCalls } = await ctx.runSubagent({ description: input.description, prompt: input.prompt, type });
    if (text.trim().length === 0) return errorResult('The sub-agent finished without a report.');
    return textResult(text, {
      kind: 'task',
      description: input.description,
      summary: text.slice(0, 400),
      toolCalls
    });
  }
};
