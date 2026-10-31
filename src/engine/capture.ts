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
  /** Radar Lock: how long a killer must stay in range, in seconds. */
  lockSeconds: number;
  /** A running lock survives until the pair is this many times the capture radius apart (GPS jitter). */
  lockExitFactor: number;
  /** A lock only advances while both samples are at most this old. */
  lockMaxSampleAgeMs: number;
  /** A lock paused by bad or stale location data is cancelled after this long. */
  lockSignalGraceMs: number;
  /** One evaluation never adds more than this much progress, whatever the gap since the last one. */
  lockMaxStepMs: number;
}

export const DEFAULT_CAPTURE: CaptureConfig = {
  captureRadiusM: 25,
  accuracyAllowanceCapM: 10,
  maxSampleSkewMs: 8_000,
  lockSeconds: 4,
  lockExitFactor: 1.2,
  lockMaxSampleAgeMs: 2_000,
  lockSignalGraceMs: 3_000,
  lockMaxStepMs: 2_000,
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
