import type { ViewerSnapshot } from "../../../src/engine";

export interface LockView {
  /** Killers see who they're locking; a locked survivor only sees that a lock exists. */
  side: "killer" | "survivor";
  targetName: string | null;
  /** 0..1 */
  progress: number;
  remainingMs: number;
  /** The lock is waiting on a good GPS signal. */
  paused: boolean;
}

/**
 * The Radar Lock to draw. Progress is the server's number at the time the snapshot was sent, then
 * extended by the time since it arrived so the bar moves smoothly between snapshots; the next
 * snapshot always corrects it. A frozen match or a signal-paused lock doesn't advance.
 */
export function lockView(
  snapshot: ViewerSnapshot,
  receivedAt: number,
  nowMs: number,
  matchPaused: boolean,
): LockView | null {
  const { radar, self } = snapshot;
  if (self.status !== "active") return null;
  let progressMs: number;
  let paused: boolean;
  let targetName: string | null = null;
  let side: LockView["side"];

  if (self.role === "killer") {
    const best = [...radar.lockedOn].sort((a, b) => b.progressMs - a.progressMs)[0];
    if (!best) return null;
    side = "killer";
    progressMs = best.progressMs;
    paused = best.paused;
    targetName = snapshot.others.find((o) => o.id === best.survivorId)?.name ?? null;
  } else {
    if (!radar.lockedBy) return null;
    side = "survivor";
    progressMs = radar.lockedBy.progressMs;
    paused = false;
  }
  const running = !paused && !matchPaused;
  const live = progressMs + (running ? Math.max(0, nowMs - receivedAt) : 0);
  const clamped = Math.min(radar.lockMs, Math.max(0, live));
  return {
    side,
    targetName,
    progress: radar.lockMs > 0 ? clamped / radar.lockMs : 0,
    remainingMs: Math.max(0, radar.lockMs - clamped),
    paused,
  };
}
