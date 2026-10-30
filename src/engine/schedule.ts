import type { Circle } from "../shared/types";
import { safeZoneForPhase, type ZonePhaseConfig } from "../geo/zones";

/**
 * Timeline of an active match. All times are SERVER epoch ms; clients never
 * supply `nowMs`. Pausing stops the clock: paused time is excluded from elapsed time.
 */
export interface MatchSchedule {
  startedAtMs: number;
  /** Total completed pause time so far. */
  pausedTotalMs: number;
  /** Set while a pause is in progress. */
  pausedAtMs: number | null;
  phases: readonly ZonePhaseConfig[];
}

export interface ZoneState {
  phaseIndex: number;
  /** Current safe zone (the outer boundary is never changed by the engine). */
  safeZone: Circle;
  /** The zone that takes effect next, or null in the final phase. */
  nextSafeZone: Circle | null;
  /** Ms until the next zone takes effect, or null in the final phase. */
  msUntilNextPhase: number | null;
  /** True while inside the warning window before the next shrink. */
  warningActive: boolean;
  /** Ms until the whole timeline (all phase holds) is over. */
  msUntilEnd: number;
  /** True once the timeline has run out. */
  finished: boolean;
}

/** Active (un-paused) milliseconds since match start. */
export function activeElapsedMs(s: MatchSchedule, nowMs: number): number {
  const currentPause = s.pausedAtMs === null ? 0 : Math.max(0, nowMs - s.pausedAtMs);
  return Math.max(0, nowMs - s.startedAtMs - s.pausedTotalMs - currentPause);
}

/** Offsets (ms from active start) at which each phase's zone takes effect. */
export function phaseStartOffsetsMs(phases: readonly ZonePhaseConfig[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const p of phases) {
    offsets.push(acc);
    acc += p.holdSeconds * 1000;
  }
  return offsets;
}

export function totalDurationMs(phases: readonly ZonePhaseConfig[]): number {
  return phases.reduce((sum, p) => sum + p.holdSeconds * 1000, 0);
}

export function computeZoneState(
  outer: Circle,
  schedule: MatchSchedule,
  nowMs: number,
): ZoneState {
  const { phases } = schedule;
  const offsets = phaseStartOffsetsMs(phases);
  const total = totalDurationMs(phases);
  const elapsed = activeElapsedMs(schedule, nowMs);
  const finished = elapsed >= total;

  let phaseIndex = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (elapsed >= (offsets[i] as number)) phaseIndex = i;
  }

  const nextIdx = phaseIndex + 1;
  const nextPhase = phases[nextIdx];
  const hasNext = nextPhase !== undefined && !finished;

  let msUntilNextPhase: number | null = null;
  let warningActive = false;
  if (hasNext) {
    const nextStart = offsets[nextIdx] as number;
    msUntilNextPhase = nextStart - elapsed;
    warningActive = msUntilNextPhase <= nextPhase.warningSeconds * 1000;
  }

  return {
    phaseIndex,
    safeZone: safeZoneForPhase(outer, phases, phaseIndex),
    nextSafeZone: hasNext ? safeZoneForPhase(outer, phases, nextIdx) : null,
    msUntilNextPhase,
    warningActive,
    msUntilEnd: Math.max(0, total - elapsed),
    finished,
  };
}
