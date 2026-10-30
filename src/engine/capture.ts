import { haversineM } from "../geo/distance";
import {
  checkSample,
  DEFAULT_FRESHNESS,
  type FreshnessPolicy,
  type SampleIssue,
} from "../geo/freshness";
import type { PlayerState } from "./players";

export interface CaptureConfig {
  /** Capture radius in metres. */
  captureRadiusM: number;
  /**
   * GPS uncertainty is forgiven up to this many metres in total (never more, so
   * nobody benefits from deliberately poor accuracy).
   */
  accuracyAllowanceCapM: number;
  /** Killer and survivor samples must have been taken within this many ms of each other. */
  maxSampleSkewMs: number;
  /** Distinct in-range sample pairs needed before a capture succeeds. */
  requiredHits: number;
}

export const DEFAULT_CAPTURE: CaptureConfig = {
  captureRadiusM: 25,
  accuracyAllowanceCapM: 10,
  maxSampleSkewMs: 8_000,
  requiredHits: 2,
};

export type CaptureRejection =
  | "match_not_active"
  | "unknown_player"
  | "same_player"
  | "not_a_killer"
  | "not_a_survivor"
  | "killer_inactive"
  | "survivor_inactive"
  | "no_location"
  | "stale_location"
  | "inaccurate_location"
  | "unreliable_location"
  | "suspicious_location"
  | "sample_skew"
  | "out_of_range";

export type Side = "killer" | "survivor";

export type ProximityResult =
  | {
      ok: true;
      distanceM: number;
      effectiveDistanceM: number;
      killerSampleMs: number;
      survivorSampleMs: number;
    }
  | { ok: false; reason: CaptureRejection; side?: Side };

const reject = (reason: CaptureRejection, side?: Side): ProximityResult =>
  side ? { ok: false, reason, side } : { ok: false, reason };

function locationReason(issues: SampleIssue[]): CaptureRejection {
  if (issues.includes("stale")) return "stale_location";
  if (issues.includes("inaccurate")) return "inaccurate_location";
  return "unreliable_location";
}

/**
 * Pure proximity check between one killer and one survivor, using only the
 * server's stored samples. Nothing a client sends can influence it.
 */
export function validateProximity(
  killer: PlayerState,
  survivor: PlayerState,
  nowMs: number,
  cfg: CaptureConfig = DEFAULT_CAPTURE,
  freshness: FreshnessPolicy = DEFAULT_FRESHNESS,
): ProximityResult {
  if (killer.id === survivor.id) return reject("same_player");
  if (killer.role !== "killer") return reject("not_a_killer");
  if (survivor.role !== "survivor") return reject("not_a_survivor");
  if (killer.status !== "active") return reject("killer_inactive");
  if (survivor.status !== "active") return reject("survivor_inactive");

  const sides: Array<[Side, PlayerState]> = [
    ["killer", killer],
    ["survivor", survivor],
  ];
  for (const [side, p] of sides) {
    if (!p.sample) return reject("no_location", side);
    const check = checkSample(p.sample, nowMs, freshness);
    if (!check.ok) return reject(locationReason(check.issues), side);
    if (p.suspicious) return reject("suspicious_location", side);
  }

  const ks = killer.sample;
  const ss = survivor.sample;
  if (!ks || !ss) return reject("no_location");

  if (Math.abs(ks.timestampMs - ss.timestampMs) > cfg.maxSampleSkewMs)
    return reject("sample_skew");

  const distanceM = haversineM(ks, ss);
  const allowance = Math.min(ks.accuracyM + ss.accuracyM, cfg.accuracyAllowanceCapM);
  const effectiveDistanceM = Math.max(0, distanceM - allowance);
  if (effectiveDistanceM > cfg.captureRadiusM) return reject("out_of_range");

  return {
    ok: true,
    distanceM,
    effectiveDistanceM,
    killerSampleMs: ks.timestampMs,
    survivorSampleMs: ss.timestampMs,
  };
}

/** Per killer>survivor pair: consecutive in-range checks on distinct sample pairs. */
export type CaptureTracker = Record<
  string,
  { hits: number; lastKillerMs: number; lastSurvivorMs: number }
>;

export type CaptureOutcome =
  | { status: "captured" }
  | { status: "pending"; hits: number; required: number }
  | { status: "rejected"; reason: CaptureRejection; side?: Side };

export function evaluateCapture(
  tracker: CaptureTracker,
  killer: PlayerState,
  survivor: PlayerState,
  nowMs: number,
  cfg: CaptureConfig = DEFAULT_CAPTURE,
  freshness: FreshnessPolicy = DEFAULT_FRESHNESS,
): { tracker: CaptureTracker; outcome: CaptureOutcome } {
  const key = `${killer.id}>${survivor.id}`;
  const result = validateProximity(killer, survivor, nowMs, cfg, freshness);

  if (!result.ok) {
    const { [key]: _dropped, ...rest } = tracker;
    const outcome: CaptureOutcome = result.side
      ? { status: "rejected", reason: result.reason, side: result.side }
      : { status: "rejected", reason: result.reason };
    return { tracker: rest, outcome };
  }

  const prev = tracker[key];
  const required = Math.max(1, cfg.requiredHits);

  // Same sample pair as last time: no new information, don't count it twice.
  if (
    prev &&
    prev.lastKillerMs === result.killerSampleMs &&
    prev.lastSurvivorMs === result.survivorSampleMs
  ) {
    return { tracker, outcome: { status: "pending", hits: prev.hits, required } };
  }

  const hits = (prev?.hits ?? 0) + 1;
  if (hits >= required) {
    const { [key]: _done, ...rest } = tracker;
    return { tracker: rest, outcome: { status: "captured" } };
  }
  return {
    tracker: {
      ...tracker,
      [key]: {
        hits,
        lastKillerMs: result.killerSampleMs,
        lastSurvivorMs: result.survivorSampleMs,
      },
    },
    outcome: { status: "pending", hits, required },
  };
}

export type KillerFacingOutcome =
  | { status: "captured" }
  | { status: "pending"; hits: number; required: number }
  | { status: "miss" }
  | { status: "rejected"; reason: CaptureRejection };

/**
 * What the killer's client is told. Anything about the survivor's side or the
 * distance collapses to a generic "miss" so repeated attempts reveal nothing
 * beyond "someone is within capture range" (which a successful tag implies anyway).
 */
export function killerFacingOutcome(outcome: CaptureOutcome): KillerFacingOutcome {
  if (outcome.status !== "rejected") return outcome;
  if (outcome.side === "killer") return { status: "rejected", reason: outcome.reason };
  switch (outcome.reason) {
    case "match_not_active":
    case "not_a_killer":
    case "killer_inactive":
      return { status: "rejected", reason: outcome.reason };
    default:
      return { status: "miss" };
  }
}
