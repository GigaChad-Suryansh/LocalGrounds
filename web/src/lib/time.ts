/** Milliseconds left on a server-supplied countdown, given when the snapshot arrived. */
export const remainingMs = (baseMs: number, receivedAt: number, now: number): number =>
  Math.max(0, baseMs - Math.max(0, now - receivedAt));

/** 75_000 -> "1:15". Rounds up so a countdown never shows 0:00 while time remains. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 0..1 progress of `remaining` within `total` (clamped). */
export const progress = (remaining: number, total: number): number =>
  total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
