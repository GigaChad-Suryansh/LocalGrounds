import { describe, it, expect } from "vitest";
import {
  canSeePosition,
  createPlayer,
  endGame,
  eventsFor,
  pauseGame,
  projectForViewer,
  revealState,
  validateRevealConfig,
  DEFAULT_REVEAL,
  type MatchSchedule,
  type PlayerState,
  type Role,
  type VisibilityContext,
  type GameEvent,
} from "../src/engine";
import { LONG_PHASES, NOW, SEC, P, activeGame, buildLobby, touch } from "./helpers";

// ------------------------------------------------------------ reveal schedule

describe("120 s location reveal schedule", () => {
  const sched = (over: Partial<MatchSchedule> = {}): MatchSchedule => ({
    startedAtMs: NOW,
    pausedTotalMs: 0,
    pausedAtMs: null,
    phases: LONG_PHASES,
    ...over,
  });

  it("is closed until the first interval, then open for the configured duration", () => {
    expect(revealState(sched(), NOW)).toEqual({
      active: false,
      index: 0,
      msRemaining: null,
      msUntilNext: 120_000,
    });
    expect(revealState(sched(), NOW + 119_999).active).toBe(false);

    const open = revealState(sched(), NOW + 120_000);
    expect(open).toEqual({ active: true, index: 1, msRemaining: 15_000, msUntilNext: 120_000 });
    expect(revealState(sched(), NOW + 134_999).active).toBe(true);

    const closed = revealState(sched(), NOW + 135_000);
    expect(closed.active).toBe(false);
    expect(closed.msUntilNext).toBe(105_000);
  });

  it("repeats every interval", () => {
    const r = revealState(sched(), NOW + 240_000);
    expect(r.active).toBe(true);
    expect(r.index).toBe(2);
  });

  it("does not run while paused and shifts after a pause", () => {
    const paused = sched({ pausedAtMs: NOW + 100 * SEC });
    expect(revealState(paused, NOW + 500 * SEC).active).toBe(false);
    const resumed = sched({ pausedTotalMs: 100 * SEC });
    expect(revealState(resumed, NOW + 219_999).active).toBe(false);
    expect(revealState(resumed, NOW + 220 * SEC).active).toBe(true);
  });

  it("validates configuration", () => {
    expect(validateRevealConfig(DEFAULT_REVEAL)).toEqual([]);
    expect(validateRevealConfig({ intervalMs: 10_000, durationMs: 10_000 })).not.toEqual([]);
    expect(validateRevealConfig({ intervalMs: 0, durationMs: 5 })).not.toEqual([]);
  });
});

// ------------------------------------------------------------ visibility rules

describe("location visibility rules", () => {
  const p = (id: string, role: Role, status: PlayerState["status"] = "active"): PlayerState => ({
    ...createPlayer(id, id, role),
    status,
  });
  const ctx = (over: Partial<VisibilityContext> = {}): VisibilityContext => ({
    matchPhase: "active",
    revealActive: false,
    teamVisibility: true,
    ...over,
  });
  const k1 = p("k1", "killer");
  const k2 = p("k2", "killer");
  const s1 = p("s1", "survivor");
  const s2 = p("s2", "survivor");

  it("a player always sees themselves", () => {
    expect(canSeePosition(s1, s1, ctx({ matchPhase: "lobby" }))).toBe(true);
  });

  it("killers do NOT see survivors outside a reveal", () => {
    expect(canSeePosition(k1, s1, ctx())).toBe(false);
  });

  it("survivors do not see killers outside a reveal", () => {
    expect(canSeePosition(s1, k1, ctx())).toBe(false);
  });

  it("everyone active sees everyone during a reveal", () => {
    expect(canSeePosition(k1, s1, ctx({ revealActive: true }))).toBe(true);
    expect(canSeePosition(s1, k1, ctx({ revealActive: true }))).toBe(true);
  });

  it("teammates see each other, unless team visibility is off", () => {
    expect(canSeePosition(k1, k2, ctx())).toBe(true);
    expect(canSeePosition(s1, s2, ctx())).toBe(true);
    expect(canSeePosition(k1, k2, ctx({ teamVisibility: false }))).toBe(false);
  });

  it("nobody sees anyone else in the lobby, while paused, or after the end", () => {
    for (const matchPhase of ["lobby", "paused", "ended"] as const) {
      const c = ctx({ matchPhase, revealActive: true });
      expect(canSeePosition(k1, k2, c)).toBe(false);
      expect(canSeePosition(k1, s1, c)).toBe(false);
    }
  });

  it("captured, eliminated and departed players neither see nor are seen", () => {
    const c = ctx({ revealActive: true });
    for (const status of ["captured", "eliminated", "left"] as const) {
      expect(canSeePosition(p("x", "survivor", status), k1, c)).toBe(false);
      expect(canSeePosition(k1, p("x", "survivor", status), c)).toBe(false);
    }
  });
});

// ------------------------------------------------------------ what clients actually receive

describe("per-viewer snapshots never leak hidden coordinates", () => {
  // Match on the exact `"lat":<value>` pair. (A bare longitude can coincide with the
  // arena centre's public longitude, which would be a false positive.)
  const coords = (state: ReturnType<typeof activeGame>, id: string) => {
    const s = P(state, id).sample;
    if (!s) throw new Error("no sample");
    return { lat: String(s.lat) };
  };
  const leaks = (json: string, c: { lat: string }) => json.includes(`"lat":${c.lat}`);

  it("hides survivors from killers before a reveal, in the serialized payload too", () => {
    const g = touch(activeGame({ phases: LONG_PHASES }), 10);
    const snap = projectForViewer(g, "k1", NOW + 10 * SEC);
    const json = JSON.stringify(snap);
    expect(leaks(json, coords(g, "s1"))).toBe(false);
    expect(leaks(json, coords(g, "s2"))).toBe(false);
    const s1 = snap.others.find((o) => o.id === "s1");
    expect(s1?.position).toBeNull();
    expect(s1?.signalLost).toBe(false);
  });

  it("shows teammates to killers", () => {
    const g = touch(activeGame({ phases: LONG_PHASES }), 10);
    const k2 = projectForViewer(g, "k1", NOW + 10 * SEC).others.find((o) => o.id === "k2");
    expect(k2?.position).not.toBeNull();
  });

  it("reveals everyone during the window and hides them again afterwards", () => {
    const g0 = activeGame({ phases: LONG_PHASES });

    const g1 = touch(g0, 125);
    const during = projectForViewer(g1, "k1", NOW + 125 * SEC);
    expect(during.reveal?.active).toBe(true);
    expect(during.reveal?.msRemaining).toBe(10_000);
    expect(leaks(JSON.stringify(during), coords(g1, "s1"))).toBe(true);
    expect(during.others.find((o) => o.id === "s1")?.position?.lat).toBe(P(g1, "s1").sample?.lat);

    const g2 = touch(g1, 136);
    const after = projectForViewer(g2, "k1", NOW + 136 * SEC);
    expect(after.reveal?.active).toBe(false);
    expect(leaks(JSON.stringify(after), coords(g2, "s1"))).toBe(false);
  });

  it("works the other way round: survivors see killers only during a reveal", () => {
    const g = touch(activeGame({ phases: LONG_PHASES }), 10);
    const before = projectForViewer(g, "s1", NOW + 10 * SEC);
    expect(before.others.find((o) => o.id === "k1")?.position).toBeNull();
    expect(before.others.find((o) => o.id === "s2")?.position).not.toBeNull();

    const g2 = touch(g, 125);
    const during = projectForViewer(g2, "s1", NOW + 125 * SEC);
    expect(during.others.find((o) => o.id === "k1")?.position).not.toBeNull();
  });

  it("marks a revealed player with no usable signal as signal lost, without coordinates", () => {
    const g = touch(activeGame({ phases: LONG_PHASES }), 125, ["s1"]); // s1 last reported at t=0
    const snap = projectForViewer(g, "k1", NOW + 125 * SEC);
    const s1 = snap.others.find((o) => o.id === "s1");
    expect(s1?.position).toBeNull();
    expect(s1?.signalLost).toBe(true);
    expect(leaks(JSON.stringify(snap), coords(g, "s1"))).toBe(false);
  });

  it("shows nobody else's position in the lobby (only readiness)", () => {
    const lobby = buildLobby();
    const snap = projectForViewer(lobby, "k1", NOW + 1 * SEC);
    expect(snap.matchPhase).toBe("lobby");
    expect(snap.zone).toBeNull();
    expect(snap.reveal).toBeNull();
    for (const o of snap.others) expect(o.position).toBeNull();
    expect(snap.others.every((o) => o.ready)).toBe(true);
    expect(leaks(JSON.stringify(snap), coords(lobby, "s1"))).toBe(false);
  });

  it("shows nobody during an emergency pause, even mid-reveal", () => {
    let g = touch(activeGame({ phases: LONG_PHASES }), 125);
    g = pauseGame(g, "s1", NOW + 125 * SEC);
    const snap = projectForViewer(g, "k1", NOW + 126 * SEC);
    expect(snap.matchPhase).toBe("paused");
    for (const o of snap.others) expect(o.position).toBeNull();
  });

  it("shows nobody once the match has ended, even at a time a reveal would have been open", () => {
    let g = touch(activeGame({ phases: LONG_PHASES }), 125);
    g = endGame(g, "k1", NOW + 125 * SEC);
    const snap = projectForViewer(g, "k1", NOW + 126 * SEC);
    expect(snap.matchPhase).toBe("ended");
    expect(snap.reveal).toBeNull();
    expect(snap.others.find((o) => o.id === "s1")?.position).toBeNull();
    expect(leaks(JSON.stringify(snap), coords(g, "s1"))).toBe(false);
  });

  it("captured players see no one", () => {
    let g = touch(activeGame({ phases: LONG_PHASES }), 125);
    g = { ...g, players: { ...g.players, s1: { ...P(g, "s1"), status: "captured" } } };
    const snap = projectForViewer(g, "s1", NOW + 125 * SEC);
    for (const o of snap.others) expect(o.position).toBeNull();
  });

  it("exposes only a whitelist of fields about other players", () => {
    const g = touch(activeGame({ phases: LONG_PHASES }), 125);
    const other = projectForViewer(g, "k1", NOW + 125 * SEC).others[0];
    expect(Object.keys(other ?? {}).sort()).toEqual(
      ["id", "name", "position", "ready", "role", "signalLost", "status"].sort(),
    );
  });

  it("gives players their own position, GPS issues and red-zone status", () => {
    const g = touch(activeGame({ phases: LONG_PHASES }), 10);
    const me = projectForViewer(g, "s1", NOW + 10 * SEC).self;
    expect(me.position?.lat).toBe(P(g, "s1").sample?.lat);
    expect(me.locationIssues).toEqual([]);
    expect(me.redZone.status).toBe("safe");
    const stale = projectForViewer(g, "s1", NOW + 100 * SEC).self;
    expect(stale.locationIssues).toContain("stale");
  });

  it("rejects projections for unknown viewers", () => {
    expect(() => projectForViewer(activeGame(), "nobody", NOW)).toThrow();
  });
});

// ------------------------------------------------------------ event audiences

describe("event audiences", () => {
  const ev = (seq: number, audience: GameEvent["audience"]): GameEvent => ({
    seq,
    atMs: NOW,
    audience,
    type: "red_zone_cleared",
  });

  it("delivers public events to everyone and private events only to their audience", () => {
    const events = [ev(1, "all"), ev(2, ["s1"]), ev(3, ["k1", "k2"])];
    expect(eventsFor("s1", events).map((e) => e.seq)).toEqual([1, 2]);
    expect(eventsFor("k1", events).map((e) => e.seq)).toEqual([1, 3]);
    expect(eventsFor("s2", events).map((e) => e.seq)).toEqual([1]);
  });
});
