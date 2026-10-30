import { activeElapsedMs, type MatchSchedule } from "./schedule";

export interface RevealConfig {
  /** Time between the starts of reveal windows (active match time). */
  intervalMs: number;
  /** How long each reveal window lasts. */
  durationMs: number;
}

export const DEFAULT_REVEAL: RevealConfig = { intervalMs: 120_000, durationMs: 15_000 };

export interface RevealState {
  active: boolean;
  /** 1-based number of the current (or most recent) reveal; 0 before the first. */
  index: number;
  /** Ms left in the window while active, else null. */
  msRemaining: number | null;
  /** Ms until the next reveal window opens. */
  msUntilNext: number;
}

export function validateRevealConfig(cfg: RevealConfig): string[] {
  const errors: string[] = [];
  if (!(cfg.intervalMs > 0)) errors.push("Reveal interval must be > 0.");
  if (!(cfg.durationMs > 0)) errors.push("Reveal duration must be > 0.");
  if (cfg.durationMs >= cfg.intervalMs)
    errors.push("Reveal duration must be shorter than the interval.");
  return errors;
}

/**
 * Reveal windows open at k * interval of ACTIVE match time (pauses don't count)
 * and last `durationMs`. Server clock only.
 */
export function revealState(
  schedule: MatchSchedule,
  nowMs: number,
  cfg: RevealConfig = DEFAULT_REVEAL,
): RevealState {
  const elapsed = activeElapsedMs(schedule, nowMs);
  const k = Math.floor(elapsed / cfg.intervalMs);
  const windowStart = k * cfg.intervalMs;
  const nextStart = (k + 1) * cfg.intervalMs;
  const inWindow = k >= 1 && elapsed - windowStart < cfg.durationMs;
  return {
    active: inWindow,
    index: k,
    msRemaining: inWindow ? windowStart + cfg.durationMs - elapsed : null,
    msUntilNext: nextStart - elapsed,
  };
}
