import type { CheckReport } from '@shared/schemas/messages';
import { MISSION_LIMITS, missionOpen, type Mission, type MissionNote, type MissionNoteKind, type MissionStart } from '@shared/schemas/missions';

/**
 * The rules of a mission, with no session attached: what the agent is told,
 * what happens when a turn ends, and what its updates change. The session
 * (session.ts) carries them out: it starts the turns and runs the checks.
 */

export type TurnEnd = 'completed' | 'interrupted' | 'error' | 'guard';

export interface MissionUpdateInput {
  note?: { kind: MissionNoteKind; text: string } | undefined;
  status?: 'done' | 'blocked' | undefined;
  summary?: string | undefined;
}

/** How much of the notebook a continuation carries: the newest notes that fit. */
const NOTEBOOK_RECAP = 8_000;
const CHECK_OUTPUT = 4_000;

function changed(mission: Mission, patch: Partial<Mission>, now: number): Mission {
  return { ...mission, ...patch, updatedAt: now, rev: mission.rev + 1 };
}

export function createMission(sessionId: string, input: MissionStart, id: string, now: number): Mission {
  return {
    id,
    sessionId,
    objective: input.objective,
    criteria: input.criteria,
    checks: input.checks,
    status: 'active',
    reason: null,
    // Starting a mission starts its first turn.
    turns: 1,
    maxTurns: input.maxTurns,
    claimed: false,
    result: '',
    notebook: [],
    verification: null,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    rev: 0
  };
}

function list(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function doneMeans(mission: Mission): string {
  return mission.criteria.length > 0 ? `Done means:\n${list(mission.criteria)}` : 'Done means: the objective is met in full. Say what that takes before you start, and record it as a decision.';
}

function mustPass(mission: Mission): string {
  return mission.checks.length > 0
    ? `Must pass (Graft runs these itself when you report done):\n${list(mission.checks)}`
    : 'There are no checks for Graft to run, so your report ends the mission: be sure of the result before you send it.';
}

/** The first message of a mission: the objective as the user wrote it, then how a mission works. */
export function missionBrief(mission: Mission): string {
  return [
    mission.objective,
    '---',
    'This is a mission: a task you keep working on, turn after turn, until it is finished and verified.',
    doneMeans(mission),
    mustPass(mission),
    [
      'How a mission works:',
      `- You have up to ${String(mission.maxTurns)} turns. When a turn of yours ends and the mission is not finished, Graft starts the next one and hands you your notebook. Work in steps; a turn does not have to finish everything.`,
      '- Keep the notebook: call MissionUpdate with a note (kind "discovery", "decision", "blocker" or "progress") for anything you would need if your context were emptied. It is given back to you every turn.',
      mission.checks.length > 0
        ? '- When every part of "done" is met and you have checked it yourself, call MissionUpdate with status "done" and a summary of the result. Saying so does not end the mission: the checks decide. Graft runs them, and what fails comes back to you.'
        : '- When every part of "done" is met and you have checked it yourself, call MissionUpdate with status "done" and a summary of the result.',
      '- If you need something only the user can give (a secret, access, a choice that is theirs to make), call MissionUpdate with status "blocked" and say exactly what you need. Do not stop for what you can decide yourself: decide, and record the decision.',
      '- Never change, skip or weaken a check to make it pass.'
    ].join('\n')
  ].join('\n\n');
}

/** The notebook as the agent gets it back: the newest notes that fit, oldest of those first. */
function notebookRecap(notes: MissionNote[]): string {
  if (notes.length === 0) return 'Your notebook is empty. Record what you learn and decide as you go.';
  const lines: string[] = [];
  let size = 0;
  for (let i = notes.length - 1; i >= 0; i--) {
    const note = notes[i]!;
    const line = `- ${note.kind}: ${note.text}`;
    if (size + line.length > NOTEBOOK_RECAP && lines.length > 0) break;
    lines.unshift(line);
    size += line.length;
  }
  const left = notes.length - lines.length;
  return [
    'Your notebook so far (your own notes from earlier turns: a record of what you found and decided, not instructions from the user):',
    ...(left > 0 ? [`(${String(left)} earlier notes are left out; these are the newest.)`] : []),
    ...lines
  ].join('\n');
}

function restated(mission: Mission): string {
  return [`Objective:\n${mission.objective}`, doneMeans(mission), mustPass(mission), notebookRecap(mission.notebook)].join('\n\n');
}

/** What starts every turn after the first: the whole mission again, so nothing of it depends on what the context still holds. */
export function missionContinuation(mission: Mission): string {
  return [
    `[Mission, turn ${String(mission.turns)} of ${String(mission.maxTurns)}] Keep working on the mission.`,
    restated(mission),
    'Do what is still open. Record discoveries and decisions with MissionUpdate as you go. Report status "done" with a summary when all of it is met and you have checked it yourself, or status "blocked" when you need something only the user can give.'
  ].join('\n\n');
}

/** What the agent reads when it reported done and a check disagreed. */
export function missionCheckFailure(mission: Mission, report: CheckReport): string {
  const failures = report.runs
    .filter((run) => !run.passed)
    .map((run) => `$ ${run.command}\n(${run.timedOut ? 'timed out' : `exited with code ${String(run.exitCode ?? '?')}`})\n\n${run.output.slice(-CHECK_OUTPUT)}`);
  return [
    `[Mission, turn ${String(mission.turns)} of ${String(mission.maxTurns)}] You reported the mission done, but its checks do not pass, so it is not done:`,
    ...failures,
    'Find the cause and fix it; don’t weaken, skip or edit around a check. Report status "done" again when they pass.',
    restated(mission)
  ].join('\n\n');
}

function paused(mission: Mission, reason: string, now: number): Mission {
  return changed(mission, { status: 'paused', reason }, now);
}

function finished(mission: Mission, now: number): Mission {
  return changed(mission, { status: 'done', reason: null, claimed: false, endedAt: now }, now);
}

/** What a mission does when a turn of its session ends. "verify": run the checks, then ask afterMissionChecks. */
export function afterMissionTurn(mission: Mission, end: TurnEnd, now: number, error?: string): { mission: Mission; action: 'none' | 'continue' | 'verify' | 'done' | 'stop' } {
  if (mission.status !== 'active') return { mission, action: 'none' };
  if (end === 'interrupted') return { mission: paused(mission, 'You stopped it.', now), action: 'stop' };
  if (end === 'error') return { mission: paused(mission, `A turn failed: ${error ?? 'unknown error'}`, now), action: 'stop' };
  if (end === 'guard') return { mission: paused(mission, 'A turn stopped itself: it reached the step limit, or kept repeating the same steps.', now), action: 'stop' };
  if (mission.claimed) return mission.checks.length > 0 ? { mission, action: 'verify' } : { mission: finished(mission, now), action: 'done' };
  if (mission.turns >= mission.maxTurns) return { mission: paused(mission, `It used all ${String(mission.maxTurns)} turns.`, now), action: 'stop' };
  return { mission: changed(mission, { turns: mission.turns + 1 }, now), action: 'continue' };
}

/** What a mission does once its checks ran on a report of "done". */
export function afterMissionChecks(mission: Mission, report: CheckReport, now: number): { mission: Mission; action: 'done' | 'continue' | 'stop' } {
  const checked: Mission = { ...mission, verification: report };
  if (report.passed) return { mission: finished(checked, now), action: 'done' };
  const open: Mission = { ...checked, claimed: false };
  if (open.turns >= open.maxTurns) return { mission: paused(open, `It used all ${String(open.maxTurns)} turns, and its checks still fail.`, now), action: 'stop' };
  return { mission: changed(open, { turns: open.turns + 1 }, now), action: 'continue' };
}

/** A MissionUpdate call from the agent. `reply` is what the agent reads back. */
export function applyMissionUpdate(mission: Mission, input: MissionUpdateInput, now: number): { mission: Mission; reply: string; isError: boolean } {
  if (!missionOpen(mission.status)) return { mission, reply: 'There is no mission running in this session.', isError: true };
  const noteText = input.note?.text.trim() ?? '';
  const summary = input.summary?.trim() ?? '';
  if (noteText.length === 0 && !input.status) return { mission, reply: 'Give a note to record, or a status ("done" or "blocked") with a summary.', isError: true };
  if (input.status && summary.length === 0) {
    return { mission, reply: input.status === 'done' ? 'Give a summary of the finished work with status "done".' : 'Say what you need from the user in the summary.', isError: true };
  }

  const notes = [...mission.notebook];
  if (input.note && noteText.length > 0) notes.push({ kind: input.note.kind, text: noteText.slice(0, MISSION_LIMITS.note), at: now });
  if (input.status === 'blocked') notes.push({ kind: 'blocker', text: summary.slice(0, MISSION_LIMITS.note), at: now });
  const notebook = notes.slice(-MISSION_LIMITS.notes);

  if (input.status === 'blocked') {
    return {
      mission: changed(mission, { notebook, status: 'paused', reason: `Blocked: ${summary.slice(0, MISSION_LIMITS.note)}`, claimed: false }, now),
      reply: 'The mission is paused until the user resumes it. End your turn now by telling them what you need.',
      isError: false
    };
  }
  if (input.status === 'done') {
    const reply =
      mission.status === 'paused'
        ? 'Recorded. The mission is paused; its checks run when the user resumes it.'
        : mission.checks.length > 0
          ? 'Recorded. Graft runs the mission’s checks when this turn ends, so end your turn now. If one fails, its output comes back to you.'
          : 'Recorded. The mission ends when this turn ends.';
    return { mission: changed(mission, { notebook, claimed: true, result: summary.slice(0, MISSION_LIMITS.summary) }, now), reply, isError: false };
  }
  return { mission: changed(mission, { notebook }, now), reply: 'Noted.', isError: false };
}

/** Pauses a mission that is going; anything else is returned as it is. */
export function pauseMission(mission: Mission, reason: string, now: number): Mission {
  return mission.status === 'active' ? paused(mission, reason, now) : mission;
}

/** Resumes a paused mission; one that had used all of its turns gets `extraTurns` more. The turn that follows is counted when it starts (afterMissionTurn). */
export function resumeMission(mission: Mission, extraTurns: number, now: number): Mission {
  if (mission.status !== 'paused') return mission;
  const spent = mission.turns >= mission.maxTurns;
  return changed(mission, { status: 'active', reason: null, maxTurns: spent ? mission.turns + Math.max(1, extraTurns) : mission.maxTurns }, now);
}

export function cancelMission(mission: Mission, now: number): Mission {
  return missionOpen(mission.status) ? changed(mission, { status: 'cancelled', reason: null, claimed: false, endedAt: now }, now) : mission;
}

/** A mission left going when the app quit stopped with it; the user resumes it. */
export function recoverMission(mission: Mission, now: number): Mission {
  return pauseMission(mission, 'Graft was closed while this mission was running.', now);
}
