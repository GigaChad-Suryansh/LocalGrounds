import type { LocationReport } from "../../../src/shared/types";

/** The server rejects fixes worse than this; the host needs a fix this good to create a room. */
export const HOST_MAX_ACCURACY_M = 30;

export type GpsStatus =
  | { state: "off" }
  | { state: "requesting" }
  | { state: "active"; accuracyM: number; at: number }
  | { state: "denied" }
  | { state: "unavailable" }
  | { state: "timeout" };

export interface GpsQualityInfo {
  level: "none" | "poor" | "fair" | "good" | "excellent";
  bars: 0 | 1 | 2 | 3 | 4;
  label: string;
}

/** Human-readable signal quality from the reported accuracy radius (metres). */
export function gpsQuality(accuracyM: number | null, issues: readonly string[] = []): GpsQualityInfo {
  if (accuracyM === null || issues.includes("stale") || issues.includes("no_location"))
    return { level: "none", bars: 0, label: "No signal" };
  if (issues.includes("inaccurate") || accuracyM > 30)
    return { level: "poor", bars: 1, label: "Weak" };
  if (accuracyM > 15) return { level: "fair", bars: 2, label: "Fair" };
  if (accuracyM > 8) return { level: "good", bars: 3, label: "Good" };
  return { level: "excellent", bars: 4, label: "Excellent" };
}

export const canHost = (s: GpsStatus): boolean =>
  s.state === "active" && s.accuracyM <= HOST_MAX_ACCURACY_M;

export function gpsErrorState(code: number): GpsStatus {
  if (code === 1) return { state: "denied" };
  if (code === 3) return { state: "timeout" };
  return { state: "unavailable" };
}

export function gpsProblemText(s: GpsStatus): string | null {
  switch (s.state) {
    case "denied":
      return "Location is blocked. Allow it in your browser's site settings, then try again.";
    case "unavailable":
      return "Your device couldn't get a position. Move outside or check that location is on.";
    case "timeout":
      return "Still waiting for a GPS fix. Move to open sky and try again.";
    default:
      return null;
  }
}

/** Shape of the browser's GeolocationPosition that we rely on (kept minimal so it is testable). */
export interface PositionLike {
  coords: { latitude: number; longitude: number; accuracy: number };
  timestamp: number;
}

/** If the position watch has been quiet this long, ask for a fresh fix explicitly. */
export const QUIET_MS = 3000;
/**
 * Browsers often stay silent while a device is stationary (iOS Safari especially), which is exactly
 * what a hiding survivor does. For this long after the last fix we re-confirm that position; after
 * it we stop, so a genuinely lost signal shows up as weak GPS instead of being papered over.
 */
export const STATIONARY_MAX_MS = 45_000;

export interface TickInput {
  hasFix: boolean;
  fixTimestamp: number;
  lastSentTimestamp: number;
  /** When the newest fix arrived (device clock). */
  lastReceivedAt: number;
  now: number;
}

export interface TickPlan {
  /** "fix": a new position. "heartbeat": re-confirm the last one. null: send nothing. */
  send: "fix" | "heartbeat" | null;
  /** Also ask the browser for a fresh fix. */
  poll: boolean;
}

/** What the tracker should do on its once-a-second tick. Pure so the rules can be tested. */
export function planTick(i: TickInput): TickPlan {
  if (!i.hasFix) return { send: null, poll: false };
  if (i.fixTimestamp !== i.lastSentTimestamp) return { send: "fix", poll: false };
  const quietMs = i.now - i.lastReceivedAt;
  if (quietMs < QUIET_MS) return { send: null, poll: false };
  return { send: quietMs <= STATIONARY_MAX_MS ? "heartbeat" : null, poll: true };
}

/**
 * The time to treat a fix as taken. A position returned by a request made with `maximumAge: 0` can't
 * be older than the request itself, so a stationary device (or a browser that reports a stale
 * `timestamp`) isn't wrongly aged. Without a request time, the browser's own timestamp is used.
 */
export const fixTimestamp = (reported: number, requestedAt = 0): number => Math.max(reported, requestedAt);

/**
 * Convert a browser position to a server report. We send the position's AGE (measured on this
 * device with one clock) rather than a timestamp, so wrong device clocks can't matter.
 */
export function toReport(p: PositionLike, nowMs: number): LocationReport {
  return {
    lat: p.coords.latitude,
    lng: p.coords.longitude,
    accuracyM: p.coords.accuracy,
    ageMs: Math.max(0, Math.round(nowMs - p.timestamp)),
  };
}
