import type { Circle, LocationSample } from "../shared/types";
import { classifyContainment } from "../geo/boundary";
import { checkSample, DEFAULT_FRESHNESS, type FreshnessPolicy } from "../geo/freshness";

export type RedZonePenalty =
  | { kind: "eliminate" }
  | { kind: "drain"; hpPerSecond: number };

export interface RedZoneConfig {
  /** Seconds a player may stay outside the safe zone before the penalty applies. */
  graceSeconds: number;
  /** Consecutive reliable "definitely outside" samples needed to start the grace countdown. */
  confirmSamples: number;
  penalty: RedZonePenalty;
  /** Cap on time credited per update, so a long data gap can't cause an instant penalty. */
  maxStepMs: number;
}

export const DEFAULT_RED_ZONE: RedZoneConfig = {
  graceSeconds: 15,
  confirmSamples: 2,
  penalty: { kind: "drain", hpPerSecond: 5 },
  maxStepMs: 10_000,
};

export type RedZoneStatus = "safe" | "warning" | "penalized" | "eliminated";

export interface RedZoneTracker {
  status: RedZoneStatus;
  consecutiveOutside: number;
  graceElapsedMs: number;
  hp: number;
  lastUpdateMs: number | null;
}

export type RedZoneEvent =
  | "none"
  | "entered_red"
  | "returned_safe"
  | "penalty_started"
  | "hp_drained"
  | "eliminated";

export interface RedZoneResult {
  tracker: RedZoneTracker;
  event: RedZoneEvent;
  /** Remaining grace in ms while status is "warning", else null. */
  graceRemainingMs: number | null;
}

export function initialRedZoneTracker(hp = 100): RedZoneTracker {
  return {
    status: "safe",
    consecutiveOutside: 0,
    graceElapsedMs: 0,
    hp,
    lastUpdateMs: null,
  };
}

const remaining = (t: RedZoneTracker, cfg: RedZoneConfig): number | null =>
  t.status === "warning" ? Math.max(0, cfg.graceSeconds * 1000 - t.graceElapsedMs) : null;

/**
 * Update a player's red-zone state from their latest location sample.
 *
 * False-elimination safeguards:
 *  - stale / inaccurate / invalid / missing samples freeze the state (never penalize);
 *  - "uncertain" samples (accuracy circle straddles the edge) freeze it too;
 *  - the grace countdown starts only after `confirmSamples` consecutive definite hits;
 *  - one definitely-inside sample fully resets the warning.
 *
 * `sample` may be undefined when no update arrived (state is frozen, clock still advances).
 */
export function updateRedZone(
  prev: RedZoneTracker,
  sample: LocationSample | undefined,
  safeZone: Circle,
  nowMs: number,
  cfg: RedZoneConfig = DEFAULT_RED_ZONE,
  freshness: FreshnessPolicy = DEFAULT_FRESHNESS,
): RedZoneResult {
  const dt =
    prev.lastUpdateMs === null
      ? 0
      : Math.min(Math.max(0, nowMs - prev.lastUpdateMs), cfg.maxStepMs);
  let t: RedZoneTracker = { ...prev, lastUpdateMs: nowMs };

  if (t.status === "eliminated") return { tracker: t, event: "none", graceRemainingMs: null };

  if (!sample || !checkSample(sample, nowMs, freshness).ok)
    return { tracker: t, event: "none", graceRemainingMs: remaining(t, cfg) };

  const where = classifyContainment(sample, safeZone);

  if (where === "uncertain")
    return { tracker: t, event: "none", graceRemainingMs: remaining(t, cfg) };

  if (where === "inside") {
    const wasOutside = t.status === "warning" || t.status === "penalized";
    t = { ...t, status: "safe", consecutiveOutside: 0, graceElapsedMs: 0 };
    return {
      tracker: t,
      event: wasOutside ? "returned_safe" : "none",
      graceRemainingMs: null,
    };
  }

  // Definitely outside the safe zone.
  t = { ...t, consecutiveOutside: t.consecutiveOutside + 1 };

  if (t.status === "safe") {
    if (t.consecutiveOutside >= cfg.confirmSamples) {
      t = { ...t, status: "warning", graceElapsedMs: 0 };
      return { tracker: t, event: "entered_red", graceRemainingMs: remaining(t, cfg) };
    }
    return { tracker: t, event: "none", graceRemainingMs: null };
  }

  if (t.status === "warning") {
    t = { ...t, graceElapsedMs: t.graceElapsedMs + dt };
    if (t.graceElapsedMs < cfg.graceSeconds * 1000)
      return { tracker: t, event: "none", graceRemainingMs: remaining(t, cfg) };

    if (cfg.penalty.kind === "eliminate") {
      t = { ...t, status: "eliminated", hp: 0 };
      return { tracker: t, event: "eliminated", graceRemainingMs: null };
    }
    t = { ...t, status: "penalized" };
    return { tracker: t, event: "penalty_started", graceRemainingMs: null };
  }

  // status === "penalized" (drain mode)
  const drain = cfg.penalty.kind === "drain" ? (cfg.penalty.hpPerSecond * dt) / 1000 : 0;
  const hp = Math.max(0, t.hp - drain);
  if (hp <= 0) {
    t = { ...t, hp: 0, status: "eliminated" };
    return { tracker: t, event: "eliminated", graceRemainingMs: null };
  }
  t = { ...t, hp };
  return { tracker: t, event: "hp_drained", graceRemainingMs: null };
}
