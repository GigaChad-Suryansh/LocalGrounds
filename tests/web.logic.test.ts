import { describe, expect, it } from "vitest";
import { projectForViewer, tickGame, type GameEvent, type MatchEndReason } from "../src/engine";
import { distanceToCenterM } from "../src/geo/boundary";
import type { ServerMessage } from "../src/server/protocol";
import {
  canHost, fixTimestamp, gpsErrorState, gpsProblemText, gpsQuality, HOST_MAX_ACCURACY_M, planTick, QUIET_MS,
  STATIONARY_MAX_MS, toReport,
} from "../web/src/lib/gps";
import { fxForEvent, type FxContext } from "../web/src/lib/fx";
import { lockView } from "../web/src/lib/lock";
import { matchOutcome, outcomeCopy } from "../web/src/lib/outcome";
import { standing } from "../web/src/lib/standing";
import { formatClock, progress, remainingMs } from "../web/src/lib/time";
import { circleRing, easeOutCubic, lerp, WORLD_RING } from "../web/src/map/geometry";
import { buildMapView } from "../web/src/map/view";
import { initialState, MAX_VISIBLE_FX, reduce, errorText, type Action, type ClientState } from "../web/src/state/store";
import { CENTER, LONG_PHASES, NOW, OUTER, SEC, activeGame, at, buildLobby, touch } from "./helpers";

// ------------------------------------------------------------------ time

describe("countdown helpers", () => {
  it("ticks down from the moment the snapshot arrived and never goes negative", () => {
    expect(remainingMs(10_000, 1_000, 1_000)).toBe(10_000);
    expect(remainingMs(10_000, 1_000, 4_500)).toBe(6_500);
    expect(remainingMs(10_000, 1_000, 99_000)).toBe(0);
    expect(remainingMs(10_000, 5_000, 4_000)).toBe(10_000); // clock never runs backwards
  });

  it("formats as m:ss and rounds up so it never shows 0:00 early", () => {
    expect(formatClock(75_000)).toBe("1:15");
    expect(formatClock(59_001)).toBe("1:00");
    expect(formatClock(500)).toBe("0:01");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(-5)).toBe("0:00");
  });

  it("clamps progress to 0..1", () => {
    expect(progress(5, 10)).toBe(0.5);
    expect(progress(50, 10)).toBe(1);
    expect(progress(-1, 10)).toBe(0);
    expect(progress(5, 0)).toBe(0);
  });
});

// ------------------------------------------------------------------ outcome

describe("match outcome", () => {
  const cases: Array<[MatchEndReason, "killer" | "survivor", string]> = [
    ["all_captured", "killer", "victory"],
    ["all_captured", "survivor", "defeat"],
    ["no_survivors", "killer", "victory"],
    ["no_survivors", "survivor", "defeat"],
    ["timeout", "survivor", "victory"],
    ["timeout", "killer", "defeat"],
    ["no_killers", "survivor", "victory"],
    ["no_killers", "killer", "defeat"],
    ["host_ended", "killer", "draw"],
    ["host_ended", "survivor", "draw"],
    ["cancelled", "survivor", "draw"],
  ];
  it.each(cases)("%s as %s is a %s", (reason, role, outcome) => {
    expect(matchOutcome(reason, role)).toBe(outcome);
  });

  it("has copy for every outcome", () => {
    expect(outcomeCopy("all_captured", "victory").title).toBe("Victory");
    expect(outcomeCopy("timeout", "defeat").title).toBe("Defeat");
    expect(outcomeCopy("host_ended", "draw")).toEqual({ title: "Match over", subtitle: "The host ended the match." });
    expect(matchOutcome(null, "killer")).toBe("draw");
  });
});

// ------------------------------------------------------------------ gps

describe("GPS helpers", () => {
  it("grades signal quality from the accuracy radius", () => {
    expect(gpsQuality(5)).toMatchObject({ level: "excellent", bars: 4 });
    expect(gpsQuality(12)).toMatchObject({ level: "good", bars: 3 });
    expect(gpsQuality(25)).toMatchObject({ level: "fair", bars: 2 });
    expect(gpsQuality(60)).toMatchObject({ level: "poor", bars: 1 });
    expect(gpsQuality(null)).toMatchObject({ level: "none", bars: 0 });
  });

  it("server-reported issues override a decent-looking accuracy", () => {
    expect(gpsQuality(5, ["stale"])).toMatchObject({ level: "none", bars: 0 });
    expect(gpsQuality(5, ["no_location"]).level).toBe("none");
    expect(gpsQuality(5, ["inaccurate"]).level).toBe("poor");
  });

  it("only lets a host create a room with a fix the server will accept", () => {
    expect(canHost({ state: "active", accuracyM: HOST_MAX_ACCURACY_M, at: 0 })).toBe(true);
    expect(canHost({ state: "active", accuracyM: HOST_MAX_ACCURACY_M + 1, at: 0 })).toBe(false);
    expect(canHost({ state: "requesting" })).toBe(false);
    expect(canHost({ state: "denied" })).toBe(false);
  });

  it("converts a browser position into a report with its age, not a timestamp", () => {
    const r = toReport({ coords: { latitude: 1.5, longitude: 2.5, accuracy: 7 }, timestamp: 10_000 }, 12_345);
    expect(r).toEqual({ lat: 1.5, lng: 2.5, accuracyM: 7, ageMs: 2345 });
    expect(toReport({ coords: { latitude: 0, longitude: 0, accuracy: 1 }, timestamp: 50_000 }, 40_000).ageMs).toBe(0);
    expect(Object.keys(r)).not.toContain("timestampMs");
  });

  describe("tracker tick plan", () => {
    const base = { hasFix: true, fixTimestamp: 1_000, lastSentTimestamp: 1_000, lastReceivedAt: 1_000 };

    it("sends nothing until there is a fix", () => {
      expect(planTick({ ...base, hasFix: false, now: 99_000 })).toEqual({ send: null, poll: false });
    });

    it("forwards a new fix straight away", () => {
      expect(planTick({ ...base, fixTimestamp: 2_000, now: 2_100 })).toEqual({ send: "fix", poll: false });
    });

    it("waits briefly after sending a fix before worrying about silence", () => {
      expect(planTick({ ...base, now: 1_000 + QUIET_MS - 1 })).toEqual({ send: null, poll: false });
    });

    it("re-confirms the last position while a stationary device is quiet, and asks for a fresh fix", () => {
      expect(planTick({ ...base, now: 1_000 + QUIET_MS })).toEqual({ send: "heartbeat", poll: true });
      expect(planTick({ ...base, now: 1_000 + STATIONARY_MAX_MS })).toEqual({ send: "heartbeat", poll: true });
    });

    it("stops papering over a long silence so a lost signal shows as weak GPS", () => {
      expect(planTick({ ...base, now: 1_000 + STATIONARY_MAX_MS + 1 })).toEqual({ send: null, poll: true });
    });
  });

  it("never treats an explicitly requested fix as older than the request itself", () => {
    expect(fixTimestamp(1_000, 5_000)).toBe(5_000); // browser reported a stale timestamp
    expect(fixTimestamp(9_000, 5_000)).toBe(9_000); // browser reported a newer one: keep it
    expect(fixTimestamp(1_000)).toBe(1_000); // watch updates: trust the browser's timestamp
  });

  it("maps geolocation errors to states and explains them", () => {
    expect(gpsErrorState(1)).toEqual({ state: "denied" });
    expect(gpsErrorState(2)).toEqual({ state: "unavailable" });
    expect(gpsErrorState(3)).toEqual({ state: "timeout" });
    expect(gpsProblemText({ state: "denied" })).toMatch(/blocked/);
    expect(gpsProblemText({ state: "active", accuracyM: 5, at: 0 })).toBeNull();
    expect(gpsProblemText({ state: "off" })).toBeNull();
  });
});

// ------------------------------------------------------------------ map geometry and view

describe("map geometry", () => {
  it("draws a circle ring at the right radius, starting north", () => {
    const ring = circleRing({ center: CENTER, radiusM: 150 }, 48);
    expect(ring).toHaveLength(48);
    for (const [lat, lng] of ring) expect(distanceToCenterM({ lat, lng }, { center: CENTER, radiusM: 0 })).toBeCloseTo(150, 0);
    expect(ring[0]?.[0]).toBeGreaterThan(CENTER.lat); // first point is due north
    expect(ring[0]?.[1]).toBeCloseTo(CENTER.lng, 5);
  });

  it("has easing and interpolation that hit their endpoints", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(WORLD_RING).toHaveLength(4);
  });
});

describe("what the map draws comes only from the viewer's snapshot", () => {
  const game = () => touch(activeGame({ phases: LONG_PHASES }), 10);

  it("shows yourself and teammates, but not hidden opponents", () => {
    const g = game();
    const view = buildMapView(projectForViewer(g, "k1", NOW + 10 * SEC));
    expect(view.players.map((p) => `${p.id}:${p.kind}`).sort()).toEqual(["k1:self", "k2:mate"]);
    expect(view.players.every((p) => p.id !== "s1" && p.id !== "s2")).toBe(true);
  });

  it("adds opponents as enemies during a reveal and skips players who are out", () => {
    let g = touch(game(), 125);
    g = { ...g, players: { ...g.players, s2: { ...g.players.s2!, status: "captured" } } };
    const view = buildMapView(projectForViewer(g, "k1", NOW + 125 * SEC));
    const kinds = Object.fromEntries(view.players.map((p) => [p.id, p.kind]));
    expect(kinds).toEqual({ k1: "self", k2: "mate", s1: "enemy" });
  });

  it("uses the whole arena as the safe zone in the lobby, and the shrunk zone in a match", () => {
    const lobby = buildMapView(projectForViewer(buildLobby(), "k1", NOW + SEC));
    expect(lobby.safe).toEqual(OUTER);
    expect(lobby.next).toBeNull();
    expect(lobby.players.map((p) => p.id)).toEqual(["k1"]);

    const g = touch(activeGame(), 70); // default test phases: 50% from 60 s
    const view = buildMapView(projectForViewer(g, "k1", NOW + 70 * SEC));
    expect(view.safe?.radiusM).toBeCloseTo(75, 6);
    expect(view.outer.radiusM).toBe(150);
    expect(view.next?.radiusM).toBeCloseTo(37.5, 6);
  });
});

describe("standing text", () => {
  const safe = { center: CENTER, radiusM: 75 };
  it("describes inside, outside the safe zone, and outside the arena", () => {
    expect(standing(at(0, 20), OUTER, safe)).toEqual({ text: "Inside the safe zone, 55 m from the edge", tone: "ok" });
    expect(standing(at(0, 70), OUTER, safe)?.tone).toBe("warn");
    expect(standing(at(0, 100), OUTER, safe)).toEqual({ text: "Outside the safe zone by 25 m", tone: "bad" });
    expect(standing(at(0, 200), OUTER, safe)).toEqual({ text: "Outside the arena by 50 m", tone: "bad" });
    expect(standing(null, OUTER, safe)).toBeNull();
  });
});

// ------------------------------------------------------------------ effects

describe("game events become feedback", () => {
  const ctx = (role: "killer" | "survivor" = "survivor"): FxContext => ({
    myId: "me",
    myRole: role,
    names: { me: "Me", k: "Kai", s: "Sam" },
  });
  const ev = (e: Partial<GameEvent> & { type: GameEvent["type"] }): GameEvent =>
    ({ seq: 1, atMs: NOW, audience: "all", ...e }) as GameEvent;

  it("tells the caught player, the tagger and bystanders different things", () => {
    expect(fxForEvent(ev({ type: "captured", killerId: "k", survivorId: "me" }), ctx())).toMatchObject({
      kind: "caught", tone: "danger", shake: true, sound: "caught",
    });
    expect(fxForEvent(ev({ type: "captured", killerId: "me", survivorId: "s" }), ctx("killer"))).toMatchObject({
      kind: "tagged", tone: "good", title: "Target captured",
    });
    expect(fxForEvent(ev({ type: "captured", killerId: "k", survivorId: "s" }), ctx())).toMatchObject({
      kind: "capture_other", title: "Sam caught",
    });
  });

  it("covers every zone, scan, red-zone and match event", () => {
    const events: GameEvent[] = [
      ev({ type: "match_started" }),
      ev({ type: "match_paused", byPlayerId: "k" }),
      ev({ type: "match_resumed" }),
      ev({ type: "match_ended", reason: "timeout" }),
      ev({ type: "zone_warning", phaseIndex: 2 }),
      ev({ type: "zone_shrunk", phaseIndex: 2 }),
      ev({ type: "reveal_started", index: 1, durationMs: 15_000 }),
      ev({ type: "reveal_ended", index: 1 }),
      ev({ type: "eliminated", playerId: "me", cause: "red_zone" }),
      ev({ type: "eliminated", playerId: "s", cause: "red_zone" }),
      ev({ type: "player_left", playerId: "s" }),
      ev({ type: "red_zone_entered", graceMs: 15_000 }),
      ev({ type: "red_zone_cleared" }),
      ev({ type: "penalty_started" }),
    ];
    for (const e of events) {
      const fx = fxForEvent(e, ctx());
      expect(fx, e.type).not.toBeNull();
      expect(fx?.title.length).toBeGreaterThan(0);
      expect(fx?.durationMs).toBeGreaterThan(0);
    }
    expect(fxForEvent(ev({ type: "player_left", playerId: "me" }), ctx())).toBeNull();
    expect(fxForEvent(ev({ type: "zone_shrunk", phaseIndex: 1 }), ctx())).toMatchObject({ shake: true, flash: true, sound: "shrink" });
    expect(fxForEvent(ev({ type: "reveal_started", index: 1, durationMs: 15_000 }), ctx())?.subtitle).toMatch(/15 seconds/);
    expect(fxForEvent(ev({ type: "red_zone_entered", graceMs: 15_000 }), ctx())?.subtitle).toMatch(/15 seconds/);
  });

  it("frames the match ending from the player's side", () => {
    const end = (reason: MatchEndReason, role: "killer" | "survivor") =>
      fxForEvent(ev({ type: "match_ended", reason }), ctx(role));
    expect(end("all_captured", "killer")).toMatchObject({ title: "Victory", tone: "good", sound: "win" });
    expect(end("all_captured", "survivor")).toMatchObject({ title: "Defeat", tone: "danger", sound: "lose" });
    expect(end("host_ended", "survivor")).toMatchObject({ title: "Match over", tone: "info" });
  });

  it("never puts coordinates into feedback", () => {
    const all = [
      fxForEvent(ev({ type: "captured", killerId: "k", survivorId: "me" }), ctx()),
      fxForEvent(ev({ type: "reveal_started", index: 1, durationMs: 15_000 }), ctx()),
      fxForEvent(ev({ type: "lock_started", targetId: "s" }), ctx("killer")),
      fxForEvent(ev({ type: "radar_locked_on" }), ctx()),
    ];
    expect(JSON.stringify(all)).not.toMatch(/lat|lng|accuracy/i);
  });

  it("Radar Lock feedback: killer sees detected/lost/captured, survivor sees a warning that names nobody", () => {
    const k = ctx("killer");
    expect(fxForEvent(ev({ type: "lock_started", targetId: "s" }), k)).toMatchObject({ kind: "lock_started", title: "Target detected" });
    expect(fxForEvent(ev({ type: "lock_lost", targetId: "s", reason: "out_of_range" }), k)).toMatchObject({ title: "Target lost" });
    expect(fxForEvent(ev({ type: "lock_lost", targetId: "s", reason: "signal" }), k)?.subtitle).toMatch(/GPS/);
    expect(fxForEvent(ev({ type: "lock_lost", targetId: "s", reason: "inactive" }), k)).toBeNull(); // the capture event says it
    expect(fxForEvent(ev({ type: "captured", killerId: "me", survivorId: "s" }), k)).toMatchObject({ title: "Target captured" });

    const warn = fxForEvent(ev({ type: "radar_locked_on" }), ctx());
    expect(warn).toMatchObject({ kind: "radar_locked_on", title: "Radar lock detected", tone: "danger", sound: "alarm" });
    expect(warn?.vibrate?.length).toBeGreaterThan(0);
    expect(fxForEvent(ev({ type: "radar_lock_cleared" }), ctx())).toMatchObject({ tone: "good" });
  });
});

// ------------------------------------------------------------------ reducer

describe("client state reducer", () => {
  const welcome: ServerMessage = { t: "welcome", token: "a".repeat(32), playerId: "s1", code: "ABCDE" };
  const server = (msg: ServerMessage, now = 1000): Action => ({ type: "server", msg, now });

  const room = {
    code: "ABCDE", hostId: "k1", maxPlayers: 12, radiusPresetsM: [30, 75, 150, 300],
    captureRadiusM: 25, lockSeconds: 4, revealIntervalMs: 120_000, revealDurationMs: 15_000,
  };

  const snapshotMsg = (viewer = "s1"): ServerMessage => ({
    t: "snapshot",
    snapshot: projectForViewer(touch(activeGame({ phases: LONG_PHASES }), 10), viewer, NOW + 10 * SEC),
    room,
  });

  const ready = (): ClientState => [welcome, snapshotMsg()].reduce((s, m) => reduce(s, server(m, 5000)), initialState());
  const event = (seq: number, body: object): ServerMessage => ({
    t: "events",
    events: [{ seq, atMs: NOW, audience: "all", ...body } as GameEvent],
  });

  it("stores the session and snapshot, and remembers when the snapshot arrived", () => {
    const s = ready();
    expect(s.session).toEqual({ token: "a".repeat(32), playerId: "s1", code: "ABCDE" });
    expect(s.snapshot?.self.id).toBe("s1");
    expect(s.room?.code).toBe("ABCDE");
    expect(s.receivedAt).toBe(5000);
    expect(s.startCheck).toBeNull();
  });

  it("turns events into feedback, using names from the snapshot", () => {
    const s = reduce(ready(), server(event(1, { type: "captured", killerId: "k1", survivorId: "s2" })));
    expect(s.fx).toHaveLength(1);
    expect(s.fx[0]).toMatchObject({ kind: "capture_other", title: "s2 caught" });
  });

  it("shows each event once, even if it is delivered again", () => {
    let s = reduce(ready(), server(event(4, { type: "zone_shrunk", phaseIndex: 1 })));
    s = reduce(s, server(event(4, { type: "zone_shrunk", phaseIndex: 1 })));
    s = reduce(s, server(event(3, { type: "zone_shrunk", phaseIndex: 1 })));
    expect(s.fx).toHaveLength(1);
    expect(s.lastSeq).toBe(4);
  });

  it("ignores events that arrive before any snapshot", () => {
    const s = reduce(reduce(initialState(), server(welcome)), server(event(1, { type: "match_started" })));
    expect(s.fx).toEqual([]);
  });

  it("keeps at most a few banners and expires them by id", () => {
    let s = ready();
    for (let i = 1; i <= 6; i++) s = reduce(s, server(event(i, { type: "zone_warning", phaseIndex: i })));
    expect(s.fx).toHaveLength(MAX_VISIBLE_FX);
    const first = s.fx[0]!;
    s = reduce(s, { type: "fx_expire", id: first.id });
    expect(s.fx.some((f) => f.id === first.id)).toBe(false);
  });

  it("restarts event numbering for a different player or room, not for a resume", () => {
    let s = reduce(ready(), server(event(9, { type: "zone_warning", phaseIndex: 1 })));
    expect(s.lastSeq).toBe(9);
    s = reduce(s, server(welcome)); // same player resuming
    expect(s.lastSeq).toBe(9);
    s = reduce(s, server({ ...welcome, playerId: "other" } as ServerMessage));
    expect(s.lastSeq).toBe(0);
  });

  it("turns lock events into banners for the right player", () => {
    let s = reduce(ready(), server(event(1, { type: "lock_started", targetId: "s2" })));
    expect(s.fx.at(-1)?.kind).toBe("lock_started");
    s = reduce(s, server(event(2, { type: "lock_lost", targetId: "s2", reason: "out_of_range" })));
    expect(s.fx.at(-1)?.kind).toBe("lock_lost");
  });

  it("records errors and location acknowledgements", () => {
    let s = reduce(initialState(), server({ t: "error", code: "room_not_found", message: "No room." }));
    expect(s.error).toMatchObject({ code: "room_not_found" });
    s = reduce(s, { type: "clear_error" });
    expect(s.error).toBeNull();
    s = reduce(s, server({ t: "location_ack", accepted: false, issues: [], rateLimited: true }));
    expect(s.locationAck).toEqual({ accepted: false, issues: [], rateLimited: true });
    expect(errorText("room_not_found", "x")).toMatch(/No room with that code/);
    expect(errorText("rule_violation", "Only the host can start.")).toBe("Only the host can start.");
  });

  it("drops an expired session so the landing screen can explain why", () => {
    const s = reduce(ready(), server({ t: "error", code: "invalid_token", message: "expired" }));
    expect(s.session).toBeNull();
    expect(s.snapshot).toBeNull();
    expect(s.sessionExpired).toBe(true);
    expect(s.error).toBeNull();
    expect(reduce(s, server(welcome)).sessionExpired).toBe(false);
  });

  it("resets on leave but keeps the GPS and network status", () => {
    let s = reduce(ready(), { type: "gps", status: { state: "active", accuracyM: 6, at: 1 } });
    s = reduce(s, { type: "net", status: "open" });
    s = reduce(s, server({ t: "left" }));
    expect(s.session).toBeNull();
    expect(s.snapshot).toBeNull();
    expect(s.gps).toEqual({ state: "active", accuracyM: 6, at: 1 });
    expect(s.net).toBe("open");
  });
});

// ------------------------------------------------------------------ radar lock view

describe("lockView", () => {
  const lockedGame = () => {
    let g = activeGame({
      phases: LONG_PHASES,
      roster: [
        { id: "k1", role: "killer", pos: [180, 3] },
        { id: "s1", role: "survivor", pos: [0, 15] },
        { id: "s2", role: "survivor", pos: [90, 120] },
      ],
    });
    for (let t = 1; t <= 3; t++) g = tickGame(touch(g, t), NOW + t * SEC); // lock at 2000 ms
    return g;
  };
  const snapFor = (id: string, g = lockedGame()) => projectForViewer(g, id, NOW + 3 * SEC);

  it("shows the killer their target, and fills smoothly between snapshots", () => {
    const v = lockView(snapFor("k1"), 10_000, 10_500, false);
    expect(v).toMatchObject({ side: "killer", targetName: "s1", paused: false });
    expect(v!.progress).toBeCloseTo(2500 / 4000, 5);
    expect(v!.remainingMs).toBe(1500);
  });

  it("never runs past 100% or backwards", () => {
    expect(lockView(snapFor("k1"), 10_000, 99_000, false)!.progress).toBe(1);
    expect(lockView(snapFor("k1"), 10_000, 5_000, false)!.progress).toBeCloseTo(0.5, 5);
  });

  it("freezes while the match is paused", () => {
    expect(lockView(snapFor("k1"), 10_000, 14_000, true)!.progress).toBeCloseTo(0.5, 5);
  });

  it("gives a locked survivor progress only, with no killer name", () => {
    const v = lockView(snapFor("s1"), 10_000, 10_000, false)!;
    expect(v.side).toBe("survivor");
    expect(v.targetName).toBeNull();
    expect(v.progress).toBeCloseTo(0.5, 5);
  });

  it("shows nothing to bystanders or to players who are out", () => {
    expect(lockView(snapFor("s2"), 10_000, 10_000, false)).toBeNull();
    const g = lockedGame();
    const out = { ...g, players: { ...g.players, s1: { ...g.players.s1!, status: "captured" as const } } };
    expect(lockView(projectForViewer(out, "s1", NOW + 3 * SEC), 10_000, 10_000, false)).toBeNull();
  });
});
