import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MISSION_LIMITS, MissionNoteKindSchema } from '@shared/schemas/missions';
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
    const { approved, feedback, plan } = await ctx.approvePlan(input.plan);
    const text = !approved
      ? `The user did not approve the plan.${feedback ? ` Feedback: ${feedback}` : ''} Stay in plan mode and revise it.`
      : plan !== input.plan
        ? `The user approved the plan after editing it. Plan mode is off; carry out their version:\n\n${plan}`
        : 'The user approved the plan. Plan mode is off; carry out the plan now.';
    // What is kept is the plan that was agreed: the user's version when they edited it.
    return textResult(text, { kind: 'plan', plan: approved ? plan : input.plan, approved, feedback });
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

export const RunAgentsInput = z.object({
  goal: z.string().min(1).max(300).describe('What this group of agents achieves together, in one line.'),
  agents: z
    .array(
      z.object({
        id: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
          .describe('A short id other agents can depend on, e.g. "explore-auth".'),
        role: z.string().min(1).max(64).describe('The agent\'s role (listed in the system prompt), or the name of a custom agent.'),
        task: z.string().min(1).max(120).describe('Three to ten words naming its task.'),
        prompt: z.string().min(1).max(20_000).describe('Complete, self-contained instructions. The agent sees nothing else, except the reports of the agents it depends on.'),
        depends_on: z.array(z.string().max(32)).max(12).optional().describe('Ids of agents whose reports this one needs. It starts when they have finished.'),
        writes: z
          .array(z.string().min(1).max(300))
          .max(20)
          .optional()
          .describe('For an agent that changes files: the files, folders or patterns (relative to the project) it may change, e.g. ["src/api/**", "docs/api.md"]. Agents whose paths do not overlap work at the same time; without writes, an agent that changes files works alone and may change anything.'),
        verify: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe('A command that must succeed (exit code 0) for this agent\'s work to count as done, e.g. "npm test -- health". When it fails, its output goes back to the agent to fix.')
      })
    )
    .min(1)
    .max(24)
});
export type RunAgentsInput = z.infer<typeof RunAgentsInput>;

export const runAgentsTool: ToolDefinition<RunAgentsInput> = {
  name: 'RunAgents',
  description: [
    'Run several agents as one group. Each has a role, a fresh context of its own and one task; agents that depend on nothing run in parallel,',
    'and an agent with depends_on starts once those have finished and receives their reports.',
    'Use it for work that splits up: explorers side by side, then implementers, then a tester and reviewers.',
    'Agents with a writing role (implementer, tester, debugger, docs) change files and run commands. Split a large change between several of them by giving each its own writes paths, so they work at the same time without touching the same file.',
    'Give an agent a verify command when its result can be checked by a command. The user sees the group as a graph and can open every agent.',
    'It returns each agent\'s report; read them and decide what happens next.'
  ].join(' '),
  input: RunAgentsInput,
  permissionClass: 'none',
  concurrencySafe: () => false,
  timeoutMs: 6 * 60 * 60_000,
  describe: (input) => Promise.resolve({ summary: `Ran ${input.agents.length === 1 ? 'an agent' : `${input.agents.length} agents`}: ${input.goal}` }),
  async execute(input, ctx) {
    const { report, agents, sources } = await ctx.runAgents(input);
    const failed = agents.length > 0 && agents.every((a) => a.status !== 'done');
    return textResult(report, { kind: 'agents', goal: input.goal, agents, ...(sources.length > 0 ? { sources } : {}) }, failed);
  }
};

export const MissionUpdateInput = z.object({
  note: z
    .object({
      kind: MissionNoteKindSchema.describe('"discovery": something you learned. "decision": a choice you made and why. "blocker": something in the way. "progress": what is finished.'),
      text: z.string().min(1).max(MISSION_LIMITS.note)
    })
    .optional()
    .describe('A note for the mission notebook. It is handed back to you at the start of every turn.'),
  status: z
    .enum(['done', 'blocked'])
    .optional()
    .describe('"done": everything the mission asks for is finished and you checked it; Graft then runs the mission\'s checks. "blocked": you need something only the user can give.'),
  summary: z.string().max(MISSION_LIMITS.summary).optional().describe('With "done": what was achieved. With "blocked": exactly what you need from the user.')
});
export type MissionUpdateInput = z.infer<typeof MissionUpdateInput>;

export const missionUpdateTool: ToolDefinition<MissionUpdateInput> = {
  name: 'MissionUpdate',
  description: [
    'Keep the mission\'s notebook and report where the mission stands.',
    'A note records a discovery, a decision, a blocker or progress; the notebook comes back to you every turn, so it outlives your context.',
    'Status "done" with a summary asks Graft to run the mission\'s checks, which decide whether it is finished.',
    'Status "blocked" with a summary pauses the mission until the user resumes it.'
  ].join(' '),
  input: MissionUpdateInput,
  permissionClass: 'none',
  concurrencySafe: () => false,
  timeoutMs: 10_000,
  describe: (input) =>
    Promise.resolve({
      summary: input.status === 'done' ? 'Reported the mission done' : input.status === 'blocked' ? 'Paused the mission: it needs you' : `Noted: ${(input.note?.text ?? '').slice(0, 80)}`
    }),
  execute(input, ctx) {
    if (!ctx.mission) return Promise.resolve(errorResult('There is no mission running in this session.'));
    const { reply, isError } = ctx.mission.update(input);
    if (isError) return Promise.resolve(errorResult(reply));
    return Promise.resolve(
      textResult(reply, { kind: 'mission', action: input.status ?? 'note', noteKind: input.status ? null : (input.note?.kind ?? null), text: (input.status ? input.summary : input.note?.text) ?? '' })
    );
  }
};

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
