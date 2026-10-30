import { describe, it, expect } from "vitest";
import { destinationPoint } from "../src/geo";
import { validatePhases, safeZoneForPhase, type ZonePhaseConfig } from "../src/geo/zones";
import {
  computeZoneState,
  activeElapsedMs,
  createMatch,
  startMatch,
  pauseMatch,
  resumeMatch,
  endMatch,
  tickMatch,
  currentZone,
  InvalidTransitionError,
  initialRedZoneTracker,
  updateRedZone,
  type MatchSchedule,
  type RedZoneConfig,
  type RedZoneTracker,
} from "../src/engine";
import type { Circle, LatLng, LocationSample } from "../src/shared/types";

const CENTER = { lat: 28.6139, lng: 77.209 };
const OUTER: Circle = { center: CENTER, radiusM: 150 };
const NOW = 1_700_000_000_000;
const SEC = 1000;

// 3 phases: 0–60 s full, 60–120 s at 50%, 120–180 s at 25%; 20 s warnings.
const PHASES: readonly ZonePhaseConfig[] = [
  { radiusFraction: 1, holdSeconds: 60, warningSeconds: 0 },
  { radiusFraction: 0.5, holdSeconds: 60, warningSeconds: 20 },
  { radiusFraction: 0.25, holdSeconds: 60, warningSeconds: 20 },
];

const schedule = (over: Partial<MatchSchedule> = {}): MatchSchedule => ({
  startedAtMs: NOW,
  pausedTotalMs: 0,
  pausedAtMs: null,
  phases: PHASES,
  ...over,
});

describe("zone schedule and countdowns (server time)", () => {
  it("starts in phase 0 with the full area and a countdown to phase 1", () => {
    const z = computeZoneState(OUTER, schedule(), NOW);
    expect(z.phaseIndex).toBe(0);
    expect(z.safeZone.radiusM).toBe(150);
    expect(z.nextSafeZone?.radiusM).toBeCloseTo(75, 6);
    expect(z.msUntilNextPhase).toBe(60 * SEC);
    expect(z.warningActive).toBe(false);
    expect(z.finished).toBe(false);
  });

  it("raises the warning exactly when the next phase is within its warning window", () => {
    expect(computeZoneState(OUTER, schedule(), NOW + 39_999).warningActive).toBe(false);
    const at40 = computeZoneState(OUTER, schedule(), NOW + 40 * SEC);
    expect(at40.warningActive).toBe(true);
    expect(at40.msUntilNextPhase).toBe(20 * SEC);
    expect(at40.nextSafeZone?.radiusM).toBeCloseTo(75, 6);
  });

  it("switches zones at the phase boundary", () => {
    const before = computeZoneState(OUTER, schedule(), NOW + 59_999);
    const at = computeZoneState(OUTER, schedule(), NOW + 60 * SEC);
    expect(before.phaseIndex).toBe(0);
    expect(at.phaseIndex).toBe(1);
    expect(at.safeZone.radiusM).toBeCloseTo(75, 6);
    expect(at.nextSafeZone?.radiusM).toBeCloseTo(37.5, 6);
  });

  it("has no next zone in the final phase and finishes when the timeline ends", () => {
    const last = computeZoneState(OUTER, schedule(), NOW + 150 * SEC);
    expect(last.phaseIndex).toBe(2);
    expect(last.nextSafeZone).toBeNull();
    expect(last.msUntilNextPhase).toBeNull();
    expect(last.warningActive).toBe(false);
    expect(last.msUntilEnd).toBe(30 * SEC);
    expect(computeZoneState(OUTER, schedule(), NOW + 180 * SEC).finished).toBe(true);
  });

  it("never changes the outer boundary or the safe-zone centre", () => {
    const z = computeZoneState(OUTER, schedule(), NOW + 130 * SEC);
    expect(OUTER.radiusM).toBe(150);
    expect(z.safeZone.center).toEqual(CENTER);
  });

  it("rejects warning windows longer than the previous hold", () => {
    expect(
      validatePhases([
        { radiusFraction: 1, holdSeconds: 10, warningSeconds: 0 },
        { radiusFraction: 0.5, holdSeconds: 10, warningSeconds: 30 },
      ]),
    ).not.toEqual([]);
  });
});

describe("pause / resume stops the clock", () => {
  it("freezes elapsed time while paused", () => {
    const s = schedule({ pausedAtMs: NOW + 30 * SEC });
    expect(activeElapsedMs(s, NOW + 30 * SEC)).toBe(30 * SEC);
    expect(activeElapsedMs(s, NOW + 500 * SEC)).toBe(30 * SEC);
  });

  it("shifts later phases by the paused duration", () => {
    let m = startMatch(createMatch(OUTER, PHASES), NOW);
    m = pauseMatch(m, NOW + 30 * SEC);
    m = resumeMatch(m, NOW + 90 * SEC); // 60 s paused
    // 100 s wall clock = 40 s active -> still phase 0
    expect(currentZone(m, NOW + 100 * SEC)?.phaseIndex).toBe(0);
    // phase 1 now begins at wall clock 120 s
    expect(currentZone(m, NOW + 119_999)?.phaseIndex).toBe(0);
    expect(currentZone(m, NOW + 120 * SEC)?.phaseIndex).toBe(1);
  });

  it("supports multiple pauses", () => {
    let m = startMatch(createMatch(OUTER, PHASES), NOW);
    m = pauseMatch(m, NOW + 10 * SEC);
    m = resumeMatch(m, NOW + 20 * SEC);
    m = pauseMatch(m, NOW + 30 * SEC);
    m = resumeMatch(m, NOW + 50 * SEC);
    expect(m.schedule?.pausedTotalMs).toBe(30 * SEC);
    expect(activeElapsedMs(m.schedule as MatchSchedule, NOW + 60 * SEC)).toBe(30 * SEC);
  });
});

describe("match phase transitions", () => {
  const fresh = () => createMatch(OUTER, PHASES);

  it("goes lobby -> active -> paused -> active -> ended", () => {
    let m = fresh();
    expect(m.phase).toBe("lobby");
    m = startMatch(m, NOW);
    expect(m.phase).toBe("active");
    m = pauseMatch(m, NOW + SEC);
    expect(m.phase).toBe("paused");
    m = resumeMatch(m, NOW + 2 * SEC);
    expect(m.phase).toBe("active");
    m = endMatch(m, NOW + 3 * SEC, "host_ended");
    expect(m.phase).toBe("ended");
    expect(m.endReason).toBe("host_ended");
  });

  it("rejects invalid transitions", () => {
    const lobby = fresh();
    const active = startMatch(lobby, NOW);
    const paused = pauseMatch(active, NOW + SEC);
    const ended = endMatch(active, NOW + SEC, "host_ended");
    expect(() => pauseMatch(lobby, NOW)).toThrow(InvalidTransitionError);
    expect(() => resumeMatch(active, NOW)).toThrow(InvalidTransitionError);
    expect(() => startMatch(active, NOW)).toThrow(InvalidTransitionError);
    expect(() => pauseMatch(paused, NOW)).toThrow(InvalidTransitionError);
    expect(() => startMatch(ended, NOW)).toThrow(InvalidTransitionError);
    expect(() => endMatch(ended, NOW, "timeout")).toThrow(InvalidTransitionError);
  });

  it("allows cancelling from the lobby", () => {
    const m = endMatch(fresh(), NOW, "cancelled");
    expect(m.phase).toBe("ended");
    expect(m.schedule).toBeNull();
  });

  it("auto-ends with 'timeout' once the zone timeline finishes", () => {
    const m = startMatch(fresh(), NOW);
    expect(tickMatch(m, NOW + 179_999).phase).toBe("active");
    const done = tickMatch(m, NOW + 180 * SEC);
    expect(done.phase).toBe("ended");
    expect(done.endReason).toBe("timeout");
  });

  it("does not auto-end while paused, however long the pause", () => {
    let m = startMatch(fresh(), NOW);
    m = pauseMatch(m, NOW + 10 * SEC);
    expect(tickMatch(m, NOW + 10_000 * SEC).phase).toBe("paused");
  });

  it("freezes the zone at the end time", () => {
    const m = endMatch(startMatch(fresh(), NOW), NOW + 70 * SEC, "host_ended");
    expect(currentZone(m, NOW + 500 * SEC)?.phaseIndex).toBe(1);
  });

  it("validates configuration on creation", () => {
    expect(() => createMatch({ center: CENTER, radiusM: 0 }, PHASES)).toThrow();
    expect(() => createMatch(OUTER, [])).toThrow();
  });
});

describe("red-zone grace and penalties", () => {
  const SAFE: Circle = { center: CENTER, radiusM: 75 };
  const inside = destinationPoint(CENTER, 0, 20);
  const outside = destinationPoint(CENTER, 0, 120);
  const nearEdge = destinationPoint(CENTER, 0, 76);

  const cfg: RedZoneConfig = {
    graceSeconds: 15,
    confirmSamples: 2,
    penalty: { kind: "eliminate" },
    maxStepMs: 10_000,
  };

  const sampleAt = (p: LatLng, offsetMs: number, accuracyM = 5): LocationSample => ({
    ...p,
    accuracyM,
    timestampMs: NOW + offsetMs,
  });

  const step = (
    t: RedZoneTracker,
    p: LatLng | undefined,
    offsetMs: number,
    c: RedZoneConfig = cfg,
    accuracyM = 5,
  ) =>
    updateRedZone(
      t,
      p ? sampleAt(p, offsetMs, accuracyM) : undefined,
      SAFE,
      NOW + offsetMs,
      c,
    );

  it("needs consecutive confirmed samples before warning", () => {
    let r = step(initialRedZoneTracker(), outside, 0);
    expect(r.tracker.status).toBe("safe");
    expect(r.event).toBe("none");
    r = step(r.tracker, outside, 2 * SEC);
    expect(r.tracker.status).toBe("warning");
    expect(r.event).toBe("entered_red");
    expect(r.graceRemainingMs).toBe(15 * SEC);
  });

  it("a single inside sample breaks the confirmation streak", () => {
    let r = step(initialRedZoneTracker(), outside, 0);
    r = step(r.tracker, inside, 2 * SEC);
    r = step(r.tracker, outside, 4 * SEC);
    expect(r.tracker.status).toBe("safe");
  });

  it("counts down the grace period then eliminates", () => {
    let r = step(initialRedZoneTracker(), outside, 0);
    r = step(r.tracker, outside, 2 * SEC); // warning starts
    r = step(r.tracker, outside, 7 * SEC);
    expect(r.graceRemainingMs).toBe(10 * SEC);
    r = step(r.tracker, outside, 12 * SEC);
    expect(r.graceRemainingMs).toBe(5 * SEC);
    r = step(r.tracker, outside, 17 * SEC);
    expect(r.event).toBe("eliminated");
    expect(r.tracker.status).toBe("eliminated");
    expect(r.tracker.hp).toBe(0);
  });

  it("returning to safety resets the penalty timer", () => {
    let r = step(initialRedZoneTracker(), outside, 0);
    r = step(r.tracker, outside, 2 * SEC);
    r = step(r.tracker, outside, 7 * SEC);
    r = step(r.tracker, inside, 9 * SEC);
    expect(r.event).toBe("returned_safe");
    expect(r.tracker.status).toBe("safe");
    expect(r.tracker.graceElapsedMs).toBe(0);
    // re-entering starts from scratch: needs confirmation again, full grace again
    r = step(r.tracker, outside, 11 * SEC);
    expect(r.tracker.status).toBe("safe");
    r = step(r.tracker, outside, 13 * SEC);
    expect(r.graceRemainingMs).toBe(15 * SEC);
  });

  it("never reacts to an uncertain sample near the edge", () => {
    let t = initialRedZoneTracker();
    for (let i = 0; i < 6; i++) {
      const r = step(t, nearEdge, i * 2 * SEC, cfg, 10);
      expect(r.tracker.status).toBe("safe");
      expect(r.event).toBe("none");
      t = r.tracker;
    }
  });

  it("freezes the grace timer on an uncertain sample", () => {
    let r = step(initialRedZoneTracker(), outside, 0);
    r = step(r.tracker, outside, 2 * SEC);
    r = step(r.tracker, outside, 7 * SEC); // 5 s elapsed
    r = step(r.tracker, nearEdge, 12 * SEC, cfg, 10);
    expect(r.tracker.status).toBe("warning");
    expect(r.graceRemainingMs).toBe(10 * SEC);
  });

  it("ignores stale, inaccurate and missing samples (no penalty)", () => {
    let r = step(initialRedZoneTracker(), outside, 0);
    r = step(r.tracker, outside, 2 * SEC);
    const warned = r.tracker;
    // stale: sample timestamp far older than "now"
    const stale = updateRedZone(warned, sampleAt(outside, 2 * SEC), SAFE, NOW + 200 * SEC, cfg);
    expect(stale.tracker.status).toBe("warning");
    expect(stale.event).toBe("none");
    // inaccurate
    const bad = step(warned, outside, 5 * SEC, cfg, 90);
    expect(bad.tracker.status).toBe("warning");
    expect(bad.tracker.graceElapsedMs).toBe(0);
    // missing
    const none = step(warned, undefined, 5 * SEC);
    expect(none.tracker.graceElapsedMs).toBe(0);
  });

  it("caps credited time after a long data gap", () => {
    let r = step(initialRedZoneTracker(), outside, 0);
    r = step(r.tracker, outside, 2 * SEC);
    r = step(r.tracker, outside, 602 * SEC); // 10-minute gap, credited as max 10 s
    expect(r.tracker.status).toBe("warning");
    expect(r.graceRemainingMs).toBe(5 * SEC);
  });

  it("supports HP drain penalties", () => {
    const drain: RedZoneConfig = {
      graceSeconds: 5,
      confirmSamples: 2,
      penalty: { kind: "drain", hpPerSecond: 10 },
      maxStepMs: 10_000,
    };
    let r = step(initialRedZoneTracker(), outside, 0, drain);
    r = step(r.tracker, outside, 1 * SEC, drain); // warning
    r = step(r.tracker, outside, 6 * SEC, drain); // grace over
    expect(r.event).toBe("penalty_started");
    expect(r.tracker.hp).toBe(100);
    r = step(r.tracker, outside, 8 * SEC, drain);
    expect(r.event).toBe("hp_drained");
    expect(r.tracker.hp).toBeCloseTo(80, 6);
    r = step(r.tracker, outside, 18 * SEC, drain); // 10 s capped step = -100
    expect(r.event).toBe("eliminated");
    expect(r.tracker.hp).toBe(0);
  });

  it("stops drain when the player returns to safety (hp is kept)", () => {
    const drain: RedZoneConfig = { ...cfg, graceSeconds: 5, penalty: { kind: "drain", hpPerSecond: 10 } };
    let r = step(initialRedZoneTracker(), outside, 0, drain);
    r = step(r.tracker, outside, 1 * SEC, drain);
    r = step(r.tracker, outside, 6 * SEC, drain);
    r = step(r.tracker, outside, 8 * SEC, drain); // hp 80
    r = step(r.tracker, inside, 9 * SEC, drain);
    expect(r.tracker.status).toBe("safe");
    expect(r.tracker.hp).toBeCloseTo(80, 6);
  });

  it("eliminated is terminal", () => {
    let r = step(initialRedZoneTracker(), outside, 0);
    r = step(r.tracker, outside, 2 * SEC);
    r = step(r.tracker, outside, 12 * SEC);
    r = step(r.tracker, outside, 22 * SEC);
    expect(r.tracker.status).toBe("eliminated");
    r = step(r.tracker, inside, 24 * SEC);
    expect(r.tracker.status).toBe("eliminated");
  });
});

describe("zone engine + red-zone tracker (simulated stationary player)", () => {
  it("player standing 60 m from centre is safe until the zone shrinks past them, then eliminated after the grace", () => {
    const player = destinationPoint(CENTER, 90, 60);
    const cfg: RedZoneConfig = {
      graceSeconds: 15,
      confirmSamples: 2,
      penalty: { kind: "eliminate" },
      maxStepMs: 10_000,
    };
    const sched = schedule();
    let tracker = initialRedZoneTracker();
    const log: Array<{ t: number; status: string; event: string }> = [];

    for (let t = 0; t <= 180; t += 5) {
      const now = NOW + t * SEC;
      const zone = computeZoneState(OUTER, sched, now);
      const r = updateRedZone(
        tracker,
        { ...player, accuracyM: 5, timestampMs: now },
        zone.safeZone,
        now,
        cfg,
      );
      tracker = r.tracker;
      if (r.event !== "none") log.push({ t, status: r.tracker.status, event: r.event });
    }

    // Phase 1 zone is 75 m (player safe). Phase 2 zone (37.5 m) starts at t=120.
    // t=120 first outside sample, t=125 confirms -> warning, 15 s grace -> eliminated at t=140.
    expect(log).toEqual([
      { t: 125, status: "warning", event: "entered_red" },
      { t: 140, status: "eliminated", event: "eliminated" },
    ]);
    expect(safeZoneForPhase(OUTER, PHASES, 2).radiusM).toBeCloseTo(37.5, 6);
  });
});
