import { MISSION_LIMITS, type Mission, type MissionStart } from '@shared/schemas/missions';

/** One entry per line: trimmed, without blank lines or repeats. */
export function linesOf(text: string): string[] {
  return [...new Set(text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0))];
}

export interface MissionForm {
  objective: string;
  /** One per line. */
  criteria: string;
  /** One command per line. */
  checks: string;
  maxTurns: string;
}

export type MissionFormResult = { ok: true; start: MissionStart } | { ok: false; field: keyof MissionForm; message: string };

/** The form as what is sent to start a mission, or what to fix first. The limits are the ones the main process enforces. */
export function missionStartFrom(form: MissionForm): MissionFormResult {
  const objective = form.objective.trim();
  if (objective.length === 0) return { ok: false, field: 'objective', message: 'Say what the mission should achieve.' };
  if (objective.length > MISSION_LIMITS.objective) return { ok: false, field: 'objective', message: `Keep the objective under ${MISSION_LIMITS.objective.toLocaleString('en-US')} characters.` };
  const criteria = linesOf(form.criteria);
  if (criteria.length > MISSION_LIMITS.criteria) return { ok: false, field: 'criteria', message: `Use at most ${String(MISSION_LIMITS.criteria)} lines.` };
  if (criteria.some((c) => c.length > MISSION_LIMITS.criterion)) return { ok: false, field: 'criteria', message: `Keep each line under ${String(MISSION_LIMITS.criterion)} characters.` };
  const checks = linesOf(form.checks);
  if (checks.length > MISSION_LIMITS.checks) return { ok: false, field: 'checks', message: `Use at most ${String(MISSION_LIMITS.checks)} commands.` };
  if (checks.some((c) => c.length > MISSION_LIMITS.check)) return { ok: false, field: 'checks', message: `Keep each command under ${MISSION_LIMITS.check.toLocaleString('en-US')} characters.` };
  const maxTurns = Number(form.maxTurns.trim());
  if (!Number.isInteger(maxTurns) || maxTurns < MISSION_LIMITS.minTurns || maxTurns > MISSION_LIMITS.maxTurns) {
    return { ok: false, field: 'maxTurns', message: `Enter a whole number from ${String(MISSION_LIMITS.minTurns)} to ${String(MISSION_LIMITS.maxTurns)}.` };
  }
  return { ok: true, start: { objective, criteria, checks, maxTurns } };
}

function turns(n: number): string {
  return `${String(n)} ${n === 1 ? 'turn' : 'turns'}`;
}

/** The mission's state in a line. `checking`: its checks are running now. */
export function missionStatusLine(mission: Mission, checking: boolean): string {
  switch (mission.status) {
    case 'active':
      if (mission.claimed) return checking ? 'Running the checks' : mission.checks.length > 0 ? 'Reported done · the checks run next' : 'Reported done';
      return `Turn ${String(mission.turns)} of ${String(mission.maxTurns)}`;
    case 'paused':
      return mission.reason ? `Paused · ${mission.reason}` : 'Paused';
    case 'done':
      return `Done in ${turns(mission.turns)}${mission.verification?.passed ? ' · checks passed' : ''}`;
    case 'cancelled':
      return `Stopped after ${turns(mission.turns)}`;
  }
}

/** The mission as a document to keep or share: what it was for, how it ended, and what the agent recorded. */
export function missionMarkdown(mission: Mission): string {
  const parts = [`# Mission: ${mission.objective}`, missionStatusLine(mission, false)];
  if (mission.criteria.length > 0) parts.push(`## Done means\n\n${mission.criteria.map((c) => `- ${c}`).join('\n')}`);
  if (mission.checks.length > 0) {
    const ran = new Map((mission.verification?.runs ?? []).map((run) => [run.command, run.passed]));
    const state = (command: string): string => (ran.has(command) ? (ran.get(command) ? 'passed' : 'failed') : 'not run yet');
    parts.push(`## Checks\n\n${mission.checks.map((command) => `- \`${command}\`: ${state(command)}`).join('\n')}`);
  }
  if (mission.result.trim().length > 0) parts.push(`## Result\n\n${mission.result.trim()}`);
  if (mission.notebook.length > 0) parts.push(`## Notebook\n\n${mission.notebook.map((note) => `- **${note.kind}**: ${note.text}`).join('\n')}`);
  return `${parts.join('\n\n')}\n`;
}
