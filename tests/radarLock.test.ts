import { describe, it, expect } from "vitest";
import {
  DEFAULT_CAPTURE,
  drainEvents,
  eventsFor,
  pauseGame,
  projectForViewer,
  resumeGame,
  tickGame,
  type GameState,
} from "../src/engine";
import type { LatLng } from "../src/shared/types";
import { LONG_PHASES, NOW, P, SEC, activeGame, at, place, touch } from "./helpers";

const LOCK_MS = DEFAULT_CAPTURE.lockSeconds * 1000;

/**
 * Killer k1 stands 3 m south of the arena centre; survivor s1 is `d` metres due north of the centre,
 * so they are d + 3 m apart. Optional extras join too.
 */
function duel(d = 20, extra: Array<{ id: string; role: "killer" | "survivor"; pos: [number, number] }> = []) {
  return activeGame({
    phases: LONG_PHASES,
    roster: [
      { id: "k1", role: "killer", pos: [180, 3] },
      { id: "s1", role: "survivor", pos: [0, d] },
      ...extra,
    ],
  });
}

/** One server second: everyone re-reports (optionally moved), then the clock ticks. */
function second(g: GameState, t: number, moves: Record<string, LatLng> = {}, acc: Record<string, number> = {}): GameState {
  let s = g;
  for (const p of Object.values(s.players)) {
    const pos = moves[p.id] ?? (p.sample ? { lat: p.sample.lat, lng: p.sample.lng } : null);
    if (pos && p.status === "active") s = place(s, p.id, pos, t, acc[p.id] ?? p.sample?.accuracyM ?? 5);
  }
  return tickGame(s, NOW + t * SEC);
}

/** Walk s1 from distance `from` to `to` (metres north of centre) at 10 m/s, one server second per step. */
function walk(g: GameState, t: number, from: number, to: number, acc: Record<string, number> = {}): [GameState, number] {
  let s = g;
  let d = from;
  let tt = t;
  while (d !== to) {
    d = d < to ? Math.min(to, d + 10) : Math.max(to, d - 10);
    s = second(s, tt++, { s1: at(0, d) }, acc);
  }
  return [s, tt];
}

const lockOf = (g: GameState, k = "k1", s = "s1") => g.locks[`${k}>${s}`];
const events = (g: GameState, type: string) => g.events.filter((e) => e.type === type);

describe("Radar Lock", () => {
  it("1. entering capture range starts a lock (and warns only the two people involved)", () => {
    let g = duel(100); // 103 m apart: nothing happens
    g = second(g, 1);
    expect(g.locks).toEqual({});
    let t: number;
    [g, t] = walk(g, 2, 100, 40); // closing in, still out of range
    expect(g.locks).toEqual({});
    [g, t] = walk(g, t, 40, 20); // now 23 m away
    expect(lockOf(g)).toMatchObject({ killerId: "k1", survivorId: "s1" });

    const started = events(g, "lock_started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ targetId: "s1", audience: ["k1"] });
    expect(events(g, "radar_locked_on")[0]).toMatchObject({ audience: ["s1"] });
    // the survivor's copy of the event never names the killer
    expect(JSON.stringify(eventsFor("s1", g.events))).not.toContain("k1");
  });

  it("2. progress reaches 100% after four valid seconds, and only then eliminates", () => {
    let g = duel();
    g = second(g, 1); // lock starts at 0%
    const seen: number[] = [];
    for (let t = 2; t <= 4; t++) {
      g = second(g, t);
      seen.push(lockOf(g)!.progressMs);
      expect(P(g, "s1").status).toBe("active");
    }
    expect(seen).toEqual([1000, 2000, 3000]);
    g = second(g, 5);
    expect(P(g, "s1").status).toBe("captured");
    expect(events(g, "captured")).toHaveLength(1);
    expect(lockOf(g)).toBeUndefined();
  });

  it("2b. a long gap between evaluations can't skip the timer", () => {
    let g = duel();
    g = second(g, 1);
    g = second(g, 30); // the server was stalled for 29 s
    expect(lockOf(g)!.progressMs).toBeLessThanOrEqual(DEFAULT_CAPTURE.lockMaxStepMs);
    expect(P(g, "s1").status).toBe("active");
  });

  it("3. leaving capture range cancels the lock and resets progress to zero", () => {
    let g = duel();
    for (let t = 1; t <= 2; t++) g = second(g, t);
    expect(lockOf(g)!.progressMs).toBe(1000);

    let t: number;
    [g, t] = walk(g, 3, 20, 60); // runs away at 10 m/s (the lock only knows their last position, so it may gain a second)
    expect(lockOf(g)).toBeUndefined();
    expect(events(g, "lock_lost")[0]).toMatchObject({ targetId: "s1", reason: "out_of_range", audience: ["k1"] });
    expect(events(g, "radar_lock_cleared")[0]).toMatchObject({ audience: ["s1"] });
    expect(P(g, "s1").status).toBe("active");

    [g, t] = walk(g, t, 60, 20); // comes back: a brand-new lock, not the old progress
    expect(events(g, "lock_started")).toHaveLength(2);
    expect(lockOf(g)!.progressMs).toBeLessThanOrEqual(1000);
  });

  it("4. GPS jitter near the edge neither starts a lock early nor resets a running one", () => {
    const tight = { k1: 1, s1: 1 };
    let g = duel(35);
    g = second(g, 1, {}, tight);
    let t: number;
    [g, t] = walk(g, 2, 35, 25, tight); // 28 m apart, 1 m accuracy: just outside the 25 m start radius
    expect(g.locks).toEqual({});

    [g, t] = walk(g, t, 25, 17, tight); // 20 m apart: lock starts
    expect(lockOf(g)).toBeDefined();
    g = second(g, t++, {}, tight);
    const before = lockOf(g)!.progressMs;
    // a jittery fix at ~28-30 m (outside 25, inside the 30 m exit radius) keeps the lock alive
    g = second(g, t++, { s1: at(0, 25) }, tight);
    g = second(g, t++, { s1: at(0, 27) }, tight);
    expect(lockOf(g)!.progressMs).toBeGreaterThan(before);
    expect(events(g, "lock_lost")).toHaveLength(0);
  });

  it("4b. bad GPS pauses the lock instead of resetting it, then it resumes and still needs its full time", () => {
    let g = duel();
    for (let t = 1; t <= 3; t++) g = second(g, t);
    g = second(g, 4, {}, { s1: 80 }); // 80 m accuracy: unreliable
    const held = lockOf(g)!.progressMs;
    expect(lockOf(g)!.paused).toBe(true);
    g = second(g, 5, {}, { s1: 80 });
    expect(lockOf(g)!.progressMs).toBe(held); // frozen, not advanced, not reset
    expect(projectForViewer(g, "k1", NOW + 5 * SEC).radar.lockedOn[0]!.paused).toBe(true);
    expect(P(g, "s1").status).toBe("active");

    for (let t = 6; t <= 12 && P(g, "s1").status === "active"; t++) g = second(g, t, {}, { s1: 5 });
    expect(P(g, "s1").status).toBe("captured");
  });

  it("5. stale location data cannot complete a lock", () => {
    let g = duel();
    for (let t = 1; t <= 2; t++) g = second(g, t); // lock at 1 s
    // both phones go silent: only the server clock moves
    for (let t = 3; t <= 40; t++) {
      if (t <= 5) expect(lockOf(g)!.progressMs).toBeLessThan(LOCK_MS);
      g = tickGame(g, NOW + t * SEC);
      expect(P(g, "s1").status).toBe("active");
    }
    expect(g.locks).toEqual({}); // paused, then cancelled after the signal grace period
    expect(events(g, "lock_lost").some((e) => e.type === "lock_lost" && e.reason === "signal")).toBe(true);
  });

  it("5b. a survivor whose samples are flagged suspicious (teleport) can't be locked", () => {
    let g = duel(100);
    g = second(g, 1);
    g = second(g, 2, { s1: at(0, 20) }); // 100 m -> 20 m in one second: implausible speed
    expect(P(g, "s1").suspicious).toBe(true);
    expect(g.locks).toEqual({});
  });

  it("6. two killers cannot both eliminate the same survivor", () => {
    let g = duel(20, [
      { id: "s2", role: "survivor", pos: [90, 130] }, // keeps the match going
      { id: "k2", role: "killer", pos: [180, 5] }, // in range of s1 too
    ]);
    for (let t = 1; t <= 8; t++) g = second(g, t);
    const captures = events(g, "captured").filter((e) => e.type === "captured" && e.survivorId === "s1");
    expect(captures).toHaveLength(1);
    expect(P(g, "s1").status).toBe("captured");
    // no lock on s1 survives, and the other killer is told so
    expect(Object.values(g.locks).some((l) => l.survivorId === "s1")).toBe(false);
    expect(P(g, "s2").status).toBe("active");
  });

  it("7. a captured survivor can never be captured or locked again", () => {
    let g = duel(20, [{ id: "s2", role: "survivor", pos: [90, 130] }]);
    for (let t = 1; t <= 5; t++) g = second(g, t);
    expect(P(g, "s1").status).toBe("captured");
    const before = events(g, "captured").length;
    const startsBefore = events(g, "lock_started").filter((e) => e.type === "lock_started" && e.targetId === "s1").length;
    for (let t = 6; t <= 20; t++) g = second(g, t);
    expect(events(g, "captured").filter((e) => e.type === "captured" && e.survivorId === "s1")).toHaveLength(1);
    expect(events(g, "captured").length).toBe(before);
    expect(events(g, "lock_started").filter((e) => e.type === "lock_started" && e.targetId === "s1")).toHaveLength(startsBefore);
  });

  it("7b. an eliminated killer can't lock anyone", () => {
    let g = duel(20, [{ id: "s2", role: "survivor", pos: [90, 130] }]);
    g = { ...g, players: { ...g.players, k1: { ...P(g, "k1"), status: "eliminated" } } };
    for (let t = 1; t <= 10; t++) g = second(g, t);
    expect(g.locks).toEqual({});
    expect(P(g, "s1").status).toBe("active");
  });

  it("8. every client sees the same server-owned progress, and only the right people see it", () => {
    let g = duel(20, [
      { id: "s2", role: "survivor", pos: [90, 130] },
      { id: "k2", role: "killer", pos: [270, 130] },
    ]);
    for (let t = 1; t <= 3; t++) g = second(g, t);
    const now = NOW + 3 * SEC;
    const killer = projectForViewer(g, "k1", now).radar;
    const target = projectForViewer(g, "s1", now).radar;
    expect(killer.lockedOn).toEqual([{ survivorId: "s1", progressMs: 2000, paused: false }]);
    expect(target.lockedBy).toEqual({ progressMs: 2000 });
    expect(killer.lockMs).toBe(LOCK_MS);
    // bystanders see no lock
    for (const id of ["k2", "s2"]) {
      const r = projectForViewer(g, id, now).radar;
      expect(r.lockedOn).toEqual([]);
      expect(r.lockedBy).toBeNull();
    }
    // the locked survivor learns nothing about where the killer is or who it is
    const text = JSON.stringify(projectForViewer(g, "s1", now));
    const k1 = P(g, "k1").sample!;
    expect(text).not.toContain(`"lat":${k1.lat}`);
    expect(JSON.stringify(projectForViewer(g, "s1", now).radar)).not.toContain("k1");
  });

  it("9. pause freezes a lock; the pause itself doesn't count towards it", () => {
    let g = duel();
    for (let t = 1; t <= 3; t++) g = second(g, t);
    g = pauseGame(g, "s1", NOW + 3 * SEC);
    g = tickGame(g, NOW + 90 * SEC);
    expect(lockOf(g)!.progressMs).toBe(2000);
    g = resumeGame(g, g.hostId, NOW + 100 * SEC);
    g = second(g, 101);
    g = second(g, 102);
    expect(lockOf(g)!.progressMs).toBeLessThanOrEqual(3000); // the 97 s pause added nothing
    expect(P(g, "s1").status).toBe("active");
  });

  it("9b. a location reveal does not complete or advance a lock by itself", () => {
    // survivor far away; a scan makes positions visible but must not create a capture
    let g = duel(120);
    g = { ...g, config: { ...g.config, reveal: { intervalMs: 10_000, durationMs: 8_000 } } };
    for (let t = 1; t <= 30; t++) g = second(g, t);
    expect(g.locks).toEqual({});
    expect(P(g, "s1").status).toBe("active");
  });

  it("drain: events are never duplicated by repeated ticks at the same instant", () => {
    let g = duel();
    g = second(g, 1);
    g = tickGame(g, NOW + 1 * SEC);
    g = tickGame(g, NOW + 1 * SEC);
    const { events: evs } = drainEvents(g);
    expect(evs.filter((e) => e.type === "lock_started")).toHaveLength(1);
  });
});
