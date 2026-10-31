import { DEFAULT_FRESHNESS, type FreshnessPolicy } from "../geo/freshness";
import { DEFAULT_CAPTURE, validateProximity, type CaptureConfig, type CaptureRejection } from "./capture";
import type { PlayerState } from "./players";

/**
 * Radar Lock: a killer inside capture range starts a lock that fills over `lockSeconds` of
 * SERVER time. Leaving range cancels it; stale or unreliable location data pauses it, then cancels
 * it. Only the server steps locks, from samples it already holds, so a client can never claim a
 * capture. Pure and clock-injected like the rest of the engine.
 */
export interface Lock {
  killerId: string;
  survivorId: string;
  startedMs: number;
  progressMs: number;
  /** Server time of the last evaluation. */
  lastEvalMs: number;
  /** Waiting on a good GPS signal: progress is held, and the lock is cancelled if it lasts too long. */
  paused: boolean;
  /** How long the lock has been paused in a row. */
  pausedMs: number;
}

export type LockTracker = Record<string, Lock>;

export const lockKey = (killerId: string, survivorId: string): string => `${killerId}>${survivorId}`;

export type LockLostReason = "out_of_range" | "signal" | "inactive";

export interface LockStepResult {
  locks: LockTracker;
  started: Lock[];
  lost: Array<{ lock: Lock; reason: LockLostReason }>;
  /** Locks that reached 100% this step, oldest first. The caller applies the capture. */
  completed: Lock[];
}

type PairState = "ok" | "pause" | "gone";

const SIGNAL_REASONS: ReadonlySet<CaptureRejection> = new Set([
  "no_location",
  "stale_location",
  "inaccurate_location",
  "unreliable_location",
  "suspicious_location",
  "sample_skew",
]);

function pairState(
  killer: PlayerState,
  survivor: PlayerState,
  nowMs: number,
  cfg: CaptureConfig,
  freshness: FreshnessPolicy,
  running: boolean,
): { state: PairState; reason?: LockLostReason } {
  // A running lock tolerates GPS jitter: it only breaks well outside the radius it started at.
  const radius = running ? cfg.captureRadiusM * cfg.lockExitFactor : cfg.captureRadiusM;
  const r = validateProximity(killer, survivor, nowMs, { ...cfg, captureRadiusM: radius }, freshness);
  if (!r.ok) {
    if (SIGNAL_REASONS.has(r.reason)) return { state: "pause", reason: "signal" };
    return { state: "gone", reason: r.reason === "out_of_range" ? "out_of_range" : "inactive" };
  }
  const oldest = Math.min(r.killerSampleMs, r.survivorSampleMs);
  if (nowMs - oldest > cfg.lockMaxSampleAgeMs) return { state: "pause", reason: "signal" };
  return { state: "ok" };
}

/** Advance every killer/survivor lock to `nowMs`. Inputs are never mutated. */
export function stepRadarLocks(
  previous: LockTracker,
  players: Record<string, PlayerState>,
  nowMs: number,
  cfg: CaptureConfig = DEFAULT_CAPTURE,
  freshness: FreshnessPolicy = DEFAULT_FRESHNESS,
): LockStepResult {
  const lockMs = cfg.lockSeconds * 1000;
  const locks: LockTracker = {};
  const started: Lock[] = [];
  const lost: LockStepResult["lost"] = [];
  const completed: Lock[] = [];
  const all = Object.values(players);
  const killers = all.filter((p) => p.role === "killer");
  const survivors = all.filter((p) => p.role === "survivor");

  for (const k of killers) {
    for (const s of survivors) {
      const key = lockKey(k.id, s.id);
      const prev = previous[key];
      const { state, reason } = pairState(k, s, nowMs, cfg, freshness, prev !== undefined);

      if (!prev) {
        if (state !== "ok") continue;
        const lock: Lock = { killerId: k.id, survivorId: s.id, startedMs: nowMs, progressMs: 0, lastEvalMs: nowMs, paused: false, pausedMs: 0 };
        locks[key] = lock;
        started.push(lock);
        continue;
      }

      const dt = Math.min(Math.max(nowMs - prev.lastEvalMs, 0), cfg.lockMaxStepMs);
      if (state === "gone") {
        lost.push({ lock: prev, reason: reason ?? "inactive" });
      } else if (state === "pause") {
        const pausedMs = prev.pausedMs + dt;
        if (pausedMs > cfg.lockSignalGraceMs) lost.push({ lock: prev, reason: "signal" });
        else locks[key] = { ...prev, paused: true, pausedMs, lastEvalMs: nowMs };
      } else {
        const progressMs = Math.min(lockMs, prev.progressMs + dt);
        const lock: Lock = { ...prev, progressMs, paused: false, pausedMs: 0, lastEvalMs: nowMs };
        if (progressMs >= lockMs) completed.push(lock);
        else locks[key] = lock;
      }
    }
  }
  completed.sort((a, b) => a.startedMs - b.startedMs || a.killerId.localeCompare(b.killerId));
  return { locks, started, lost, completed };
}

/** Fraction 0..1 of a lock. */
export const lockProgress = (lock: Pick<Lock, "progressMs">, cfg: CaptureConfig): number =>
  Math.min(1, lock.progressMs / (cfg.lockSeconds * 1000));
