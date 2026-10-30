import type { Circle } from "../shared/types";
import { validatePhases, type ZonePhaseConfig } from "../geo/zones";
import { computeZoneState, type MatchSchedule, type ZoneState } from "./schedule";

export type MatchPhase = "lobby" | "active" | "paused" | "ended";
export type MatchEndReason =
  | "timeout"
  | "host_ended"
  | "all_captured"
  | "no_survivors"
  | "no_killers"
  | "cancelled";

/**
 * Core match record. The outer boundary is set once and never modified;
 * only the safe zone (derived from the schedule) moves.
 */
export interface MatchCore {
  phase: MatchPhase;
  outer: Circle;
  phases: readonly ZonePhaseConfig[];
  schedule: MatchSchedule | null;
  endedAtMs: number | null;
  endReason: MatchEndReason | null;
}

export class InvalidTransitionError extends Error {
  constructor(from: MatchPhase, action: string) {
    super(`Cannot ${action} a match that is ${from}.`);
    this.name = "InvalidTransitionError";
  }
}

export function createMatch(outer: Circle, phases: readonly ZonePhaseConfig[]): MatchCore {
  if (!(outer.radiusM > 0)) throw new Error("Outer radius must be positive.");
  const errors = validatePhases(phases);
  if (errors.length > 0) throw new Error(`Invalid phases: ${errors.join(" ")}`);
  return {
    phase: "lobby",
    outer: { center: { ...outer.center }, radiusM: outer.radiusM },
    phases,
    schedule: null,
    endedAtMs: null,
    endReason: null,
  };
}

export function startMatch(m: MatchCore, nowMs: number): MatchCore {
  if (m.phase !== "lobby") throw new InvalidTransitionError(m.phase, "start");
  return {
    ...m,
    phase: "active",
    schedule: {
      startedAtMs: nowMs,
      pausedTotalMs: 0,
      pausedAtMs: null,
      phases: m.phases,
    },
  };
}

export function pauseMatch(m: MatchCore, nowMs: number): MatchCore {
  if (m.phase !== "active" || !m.schedule) throw new InvalidTransitionError(m.phase, "pause");
  return { ...m, phase: "paused", schedule: { ...m.schedule, pausedAtMs: nowMs } };
}

export function resumeMatch(m: MatchCore, nowMs: number): MatchCore {
  if (m.phase !== "paused" || !m.schedule || m.schedule.pausedAtMs === null)
    throw new InvalidTransitionError(m.phase, "resume");
  const pausedFor = Math.max(0, nowMs - m.schedule.pausedAtMs);
  return {
    ...m,
    phase: "active",
    schedule: {
      ...m.schedule,
      pausedTotalMs: m.schedule.pausedTotalMs + pausedFor,
      pausedAtMs: null,
    },
  };
}

export function endMatch(m: MatchCore, nowMs: number, reason: MatchEndReason): MatchCore {
  if (m.phase === "ended") throw new InvalidTransitionError(m.phase, "end");
  return { ...m, phase: "ended", endedAtMs: nowMs, endReason: reason };
}

/**
 * Advance time-driven transitions. Call on every server tick: ends an active
 * match once the zone timeline is exhausted. Paused/ended matches are unchanged.
 */
export function tickMatch(m: MatchCore, nowMs: number): MatchCore {
  if (m.phase !== "active" || !m.schedule) return m;
  const zone = computeZoneState(m.outer, m.schedule, nowMs);
  return zone.finished ? endMatch(m, nowMs, "timeout") : m;
}

/** Zone state as of `nowMs` (frozen at the end time once the match has ended). */
export function currentZone(m: MatchCore, nowMs: number): ZoneState | null {
  if (!m.schedule) return null;
  const at = m.phase === "ended" && m.endedAtMs !== null ? m.endedAtMs : nowMs;
  return computeZoneState(m.outer, m.schedule, at);
}
