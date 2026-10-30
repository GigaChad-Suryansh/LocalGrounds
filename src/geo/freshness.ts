import type { LocationSample } from "../shared/types";
import { isValidLatLng, haversineM } from "./distance";

export interface FreshnessPolicy {
  /** Max age of a sample (server receipt time based) to be considered current. */
  maxAgeMs: number;
  /** Samples with worse (larger) accuracy than this are unreliable. */
  maxAccuracyM: number;
  /** Max plausible speed in m/s between consecutive samples (e.g. sprinting ≈ 10). */
  maxSpeedMps: number;
  /** Max allowed device-clock skew into the future, ms. */
  maxFutureSkewMs: number;
}

export const DEFAULT_FRESHNESS: FreshnessPolicy = {
  maxAgeMs: 15_000,
  maxAccuracyM: 30,
  maxSpeedMps: 12,
  maxFutureSkewMs: 5_000,
};

export type SampleIssue =
  | "invalid_coordinates"
  | "invalid_accuracy"
  | "stale"
  | "from_future"
  | "inaccurate";

export interface SampleCheck {
  ok: boolean;
  issues: SampleIssue[];
  ageMs: number;
}

/** Validate a single sample against server time. */
export function checkSample(
  sample: LocationSample,
  nowMs: number,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS,
): SampleCheck {
  const issues: SampleIssue[] = [];
  const ageMs = nowMs - sample.timestampMs;

  if (!isValidLatLng(sample)) issues.push("invalid_coordinates");
  if (!Number.isFinite(sample.accuracyM) || sample.accuracyM < 0)
    issues.push("invalid_accuracy");
  else if (sample.accuracyM > policy.maxAccuracyM) issues.push("inaccurate");
  if (ageMs < -policy.maxFutureSkewMs) issues.push("from_future");
  else if (ageMs > policy.maxAgeMs) issues.push("stale");

  return { ok: issues.length === 0, issues, ageMs };
}

export function isFresh(
  sample: LocationSample | undefined,
  nowMs: number,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS,
): boolean {
  return sample !== undefined && checkSample(sample, nowMs, policy).ok;
}

/**
 * Detect an implausible jump between consecutive samples (teleporting / spoofing).
 * The allowance grows with both samples' accuracy so GPS noise is not flagged.
 */
export function isSuspiciousJump(
  prev: LocationSample,
  next: LocationSample,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS,
): boolean {
  const dtSec = (next.timestampMs - prev.timestampMs) / 1000;
  if (dtSec <= 0) return true; // out-of-order or duplicate timestamps
  const dist = haversineM(prev, next);
  const noiseAllowance = Math.max(0, prev.accuracyM) + Math.max(0, next.accuracyM);
  const excess = Math.max(0, dist - noiseAllowance);
  return excess / dtSec > policy.maxSpeedMps;
}
