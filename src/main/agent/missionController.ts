import type { AgentEvent } from '@shared/schemas/agentEvents';
import type { CheckReport } from '@shared/schemas/messages';
import { missionOpen, type Mission } from '@shared/schemas/missions';
import { GraftError } from '@shared/errors';
import type { SessionStore } from '../db/sessionsRepo';
import type { ShellManager } from '../tools/shell/shellManager';
import { checksSummary, runChecks } from './checks';
import {
  afterMissionChecks,
  afterMissionTurn,
  applyMissionUpdate,
  cancelMission,
  missionCheckFailure,
  missionContinuation,
  pauseMission,
  resumeMission,
  type MissionUpdateInput,
  type TurnEnd
} from './mission';

/** How long one of a mission's checks may run. */
const MISSION_CHECK_TIMEOUT_SEC = 600;

/** The turn a mission asks for next: its checks on a report of "done", or the mission restated. */
export type MissionTurn = { kind: 'verify' } | { kind: 'step'; text: string; turn: number; of: number };

/** What a mission needs from the session it runs in. */
export interface MissionPorts {
  sessionId: string;
  store: Pick<SessionStore, 'getMission' | 'saveMission' | 'appendMessage'>;
  shells: ShellManager;
  emit(event: AgentEvent): void;
  notify(kind: 'needs-input' | 'finished', text: string): void;
  log(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, string | number | boolean>): void;
  workingDir(): string;
  /** Points the session's shell at its sandbox before the checks run there. */
  syncSandbox(): Promise<void>;
}

/**
 * Carries a session's mission from turn to turn. The rules are the pure functions of
 * mission.ts; this keeps the stored mission in step with them, tells the interface, and
 * runs the checks. Which turn runs when stays with the session, which owns the queue.
 */
export class MissionController {
  constructor(private readonly ports: MissionPorts) {}

  /** The session's newest mission, whatever its state. */
  current(): Mission | null {
    return this.ports.store.getMission(this.ports.sessionId);
  }

  /** A mission is going or paused: the session can't start another, and the agent may report on it. */
  isOpen(): boolean {
    const mission = this.current();
    return mission !== null && missionOpen(mission.status);
  }

  save(mission: Mission): void {
    this.ports.store.saveMission(mission);
    this.ports.emit({ type: 'mission', mission });
  }

  /** Pauses the mission. A turn that is running finishes its work; nothing follows it until the mission is resumed. */
  pause(): void {
    const mission = this.current();
    if (mission?.status !== 'active') throw new GraftError('no_mission', 'There is no mission running to pause.');
    this.save(pauseMission(mission, 'You paused it.', Date.now()));
  }

  /** Marks a paused mission as going again; one that had used all of its turns gets `extraTurns` more. */
  resume(extraTurns: number): void {
    const mission = this.current();
    if (mission?.status !== 'paused') throw new GraftError('no_mission', 'There is no paused mission to resume.');
    this.save(resumeMission(mission, extraTurns, Date.now()));
  }

  /** Ends the mission for good. */
  cancel(): void {
    const mission = this.current();
    if (!mission || !missionOpen(mission.status)) throw new GraftError('no_mission', 'There is no mission to stop.');
    this.save(cancelMission(mission, Date.now()));
  }

  /** A MissionUpdate call from the agent. */
  update(input: MissionUpdateInput): { reply: string; isError: boolean } {
    const mission = this.current();
    if (!mission) return { reply: 'There is no mission running in this session.', isError: true };
    const next = applyMissionUpdate(mission, input, Date.now());
    if (next.mission !== mission) this.save(next.mission);
    if (!next.isError && input.status === 'blocked') this.ports.notify('needs-input', `Mission blocked: ${input.summary ?? ''}`.slice(0, 200));
    return { reply: next.reply, isError: next.isError };
  }

  /**
   * What the mission does now that a turn ended: it pauses (a stop, a failure,
   * no turns left), ends (done, with nothing to check), or goes on, in which
   * case this returns the turn to start.
   */
  afterTurn(end: TurnEnd, error: string | null): MissionTurn | null {
    const mission = this.current();
    if (!mission) return null;
    const next = afterMissionTurn(mission, end, Date.now(), error ?? undefined);
    if (next.mission !== mission) this.save(next.mission);
    switch (next.action) {
      case 'none':
        return null;
      case 'stop':
        this.ports.notify('needs-input', `Mission paused: ${next.mission.reason ?? ''}`.slice(0, 200));
        return null;
      case 'done':
        this.done(next.mission);
        return null;
      case 'verify':
        return { kind: 'verify' };
      case 'continue':
        return { kind: 'step', text: missionContinuation(next.mission), turn: next.mission.turns, of: next.mission.maxTurns };
    }
  }

  private done(mission: Mission): void {
    this.ports.log('info', 'Mission done', { session: this.ports.sessionId, turns: mission.turns });
    this.ports.notify('finished', `Mission done: ${mission.objective}`.slice(0, 200));
  }

  /**
   * Runs the mission's checks on the agent's report of "done". Returns what
   * the agent is told when they fail, or null when the turn has nothing more
   * to do (they passed, the mission paused, or the turn was stopped).
   */
  async verify(turnId: string, signal: AbortSignal): Promise<{ text: string; turn: number; of: number } | null> {
    const mission = this.current();
    if (mission?.status !== 'active' || !mission.claimed) return null;
    const round = (mission.verification?.round ?? 0) + 1;
    this.ports.emit({ type: 'checks', commands: mission.checks, round });
    let report: CheckReport;
    try {
      await this.ports.syncSandbox();
      report = await runChecks({ commands: mission.checks, fix: true, timeoutSec: MISSION_CHECK_TIMEOUT_SEC }, round, {
        sessionId: this.ports.sessionId,
        cwd: this.ports.workingDir(),
        signal,
        shells: this.ports.shells
      });
    } catch (error) {
      if (signal.aborted) return null;
      const reason = `Its checks couldn't run: ${(error as Error).message}`;
      this.save(pauseMission(mission, reason, Date.now()));
      this.ports.notify('needs-input', `Mission paused: ${reason}`.slice(0, 200));
      return null;
    }
    // Stopped part-way: the turn ends as interrupted, which pauses the mission with its report still standing.
    if (signal.aborted) return null;
    const stored = this.ports.store.appendMessage(this.ports.sessionId, 'user', [{ type: 'text', text: checksSummary(report) }], { turnId, kind: 'check', check: report });
    this.ports.emit({ type: 'message', message: stored });
    const next = afterMissionChecks(mission, report, Date.now());
    this.save(next.mission);
    if (next.action === 'done') {
      this.done(next.mission);
      return null;
    }
    if (next.action === 'stop') {
      this.ports.notify('needs-input', `Mission paused: ${next.mission.reason ?? ''}`.slice(0, 200));
      return null;
    }
    return { text: missionCheckFailure(next.mission, report), turn: next.mission.turns, of: next.mission.maxTurns };
  }
}
