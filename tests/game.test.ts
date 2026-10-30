import { describe, it, expect } from "vitest";
import {
  addPlayer,
  attemptCapture,
  confirmSafety,
  drainEvents,
  endGame,
  eventsFor,
  evaluateStart,
  GameRuleError,
  ingestLocation,
  killerFacingOutcome,
  leaveGame,
  pauseGame,
  resumeGame,
  setReady,
  startGame,
  tickGame,
  currentZone,
  type GameState,
} from "../src/engine";
import { ELIMINATE, NOW, SEC, P, at, buildLobby, activeGame, place, report } from "./helpers";

// ------------------------------------------------------------ starting a match

describe("start gating", () => {
  it("starts when the host confirmed safety, everyone is ready, eligible and in the area", () => {
    const lobby = buildLobby();
    expect(evaluateStart(lobby, NOW + SEC)).toMatchObject({ canStart: true, blockers: [] });
    const g = startGame(lobby, lobby.hostId, NOW + SEC);
    expect(g.match.phase).toBe("active");
    expect(g.events.map((e) => e.type)).toContain("match_started");
  });

  it("is blocked until the host confirms the area is safe", () => {
    const lobby = buildLobby({ safety: false });
    expect(evaluateStart(lobby, NOW).blockers).toContain("safety_not_confirmed");
    expect(() => startGame(lobby, lobby.hostId, NOW)).toThrow(GameRuleError);
    expect(() => confirmSafety(lobby, "s1")).toThrow(GameRuleError);
    expect(evaluateStart(confirmSafety(lobby, lobby.hostId), NOW).canStart).toBe(true);
  });

  it("is blocked until everyone is ready", () => {
    const lobby = buildLobby({ ready: false });
    expect(evaluateStart(lobby, NOW).blockers).toContain("players_not_ready");
  });

  it("needs at least one killer and one survivor", () => {
    const onlySurvivors = buildLobby({
      roster: [
        { id: "s1", role: "survivor", pos: [0, 50] },
        { id: "s2", role: "survivor", pos: [90, 50] },
      ],
    });
    expect(evaluateStart(onlySurvivors, NOW).blockers).toContain("not_enough_killers");
  });

  it("is blocked when a player is outside the starting area", () => {
    const lobby = place(buildLobby(), "s1", at(0, 400), 1);
    const ev = evaluateStart(lobby, NOW + 2 * SEC);
    expect(ev.blockers).toContain("players_ineligible");
    expect(ev.players.find((p) => p.playerId === "s1")?.issues).toContain("outside_start_area");
  });

  it("is blocked when locations are stale, missing or inaccurate", () => {
    const lobby = buildLobby();
    const stale = evaluateStart(lobby, NOW + 60 * SEC);
    expect(stale.players.every((p) => p.issues.includes("stale_location"))).toBe(true);

    const withNewcomer = addPlayer(lobby, { id: "s3", name: "s3", role: "survivor" });
    const noLoc = evaluateStart(setReady(withNewcomer, "s3", true), NOW + SEC);
    expect(noLoc.players.find((p) => p.playerId === "s3")?.issues).toEqual(["no_location"]);

    const weak = place(lobby, "s2", at(270, 100), 1, 80);
    expect(evaluateStart(weak, NOW + 2 * SEC).players.find((p) => p.playerId === "s2")?.issues).toContain(
      "inaccurate_location",
    );
  });

  it("only the host can start, and nobody joins after the start", () => {
    const lobby = buildLobby();
    expect(() => startGame(lobby, "s1", NOW)).toThrow(GameRuleError);
    const g = startGame(lobby, lobby.hostId, NOW);
    expect(() => addPlayer(g, { id: "late", name: "late", role: "survivor" })).toThrow(GameRuleError);
  });
});

// ------------------------------------------------------------ location ingestion

describe("location ingestion is server-authoritative", () => {
  it("rejects malformed reports and stores nothing", () => {
    const lobby = buildLobby();
    const before = P(lobby, "s1").sample;
    const bad = ingestLocation(lobby, "s1", { lat: 120, lng: 0, accuracyM: 5 }, NOW + SEC);
    expect(bad.accepted).toBe(false);
    expect(bad.issues).toContain("invalid_coordinates");
    expect(P(bad.state, "s1").sample).toEqual(before);
    expect(ingestLocation(lobby, "s1", { lat: 1, lng: 1, accuracyM: -3 }, NOW + SEC).accepted).toBe(false);
  });

  it("derives the sample time from the server clock and the reported age", () => {
    const lobby = buildLobby();
    const r = ingestLocation(lobby, "s1", report(at(0, 50), 5, 3_000), NOW + 10 * SEC);
    expect(P(r.state, "s1").sample?.timestampMs).toBe(NOW + 7 * SEC);
  });

  it("ignores out-of-order and duplicate reports", () => {
    let s = place(buildLobby(), "s1", at(180, 101), 5);
    const stamp = P(s, "s1").sample?.timestampMs;
    const late = ingestLocation(s, "s1", report(at(180, 102)), NOW + 3 * SEC);
    expect(late.accepted).toBe(false);
    s = late.state;
    expect(P(s, "s1").sample?.timestampMs).toBe(stamp);
  });

  it("flags teleport jumps as suspicious, then clears the flag once movement is plausible", () => {
    let s = buildLobby();
    s = place(s, "s1", at(0, 120), 1); // from 180°/100 m to 0°/120 m in 1 s
    expect(P(s, "s1").suspicious).toBe(true);
    s = place(s, "s1", at(0, 121), 3);
    expect(P(s, "s1").suspicious).toBe(false);
  });

  it("tells the client what is wrong with a poor report", () => {
    const r = ingestLocation(buildLobby(), "s1", report(at(180, 100), 80), NOW + SEC);
    expect(r.accepted).toBe(true);
    expect(r.issues).toContain("inaccurate");
  });

  it("ignores reports from unknown or departed players", () => {
    const g = buildLobby();
    expect(ingestLocation(g, "ghost", report(at(0, 1)), NOW + SEC).accepted).toBe(false);
    const gone = leaveGame(g, "s1", NOW + SEC);
    expect(ingestLocation(gone, "s1", report(at(0, 1)), NOW + 2 * SEC).accepted).toBe(false);
  });
});

// ------------------------------------------------------------ capture through the game

describe("capturing (simulated chase)", () => {
  const duel = () =>
    activeGame({
      roster: [
        { id: "k1", role: "killer", pos: [0, 60] },
        { id: "s1", role: "survivor", pos: [0, 100] },
      ],
    });

  it("is validated by the server from stored samples and ends the match when the last survivor falls", () => {
    let g = duel();

    // t=1: 40 m apart -> miss (and the killer is told nothing about distance)
    let r = attemptCapture(g, "k1", "s1", NOW + 1 * SEC);
    expect(r.outcome).toMatchObject({ status: "rejected", reason: "out_of_range" });
    expect(killerFacingOutcome(r.outcome)).toEqual({ status: "miss" });
    g = r.state;

    // t=5: survivor walks 20 m towards the killer
    g = place(g, "s1", at(0, 80), 5);
    g = place(g, "k1", at(0, 60), 5);
    r = attemptCapture(g, "k1", "s1", NOW + 5 * SEC);
    expect(r.outcome).toEqual({ status: "pending", hits: 1, required: 2 });
    g = r.state;
    r = attemptCapture(g, "k1", "s1", NOW + 5 * SEC); // same samples: not counted twice
    expect(r.outcome).toEqual({ status: "pending", hits: 1, required: 2 });
    g = r.state;

    // t=7: fresh samples, still in range -> captured
    g = place(g, "s1", at(0, 80), 7);
    g = place(g, "k1", at(0, 60), 7);
    r = attemptCapture(g, "k1", "s1", NOW + 7 * SEC);
    expect(r.outcome).toEqual({ status: "captured" });
    g = r.state;

    expect(P(g, "s1").status).toBe("captured");
    expect(g.match.phase).toBe("ended");
    expect(g.match.endReason).toBe("all_captured");

    const captured = g.events.find((e) => e.type === "captured");
    expect(captured).toMatchObject({ killerId: "k1", survivorId: "s1", audience: "all" });
    expect(JSON.stringify(captured)).not.toMatch(/lat|lng/);
  });

  it("cannot capture without server-side locations, however the request is phrased", () => {
    const base = duel();
    const g: GameState = {
      ...base,
      players: { ...base.players, s1: { ...P(base, "s1"), sample: null } },
    };
    const r = attemptCapture(g, "k1", "s1", NOW + SEC);
    expect(r.outcome).toEqual({ status: "rejected", reason: "no_location", side: "survivor" });
    expect(killerFacingOutcome(r.outcome)).toEqual({ status: "miss" });
    expect(P(r.state, "s1").status).toBe("active");
  });

  it("refuses to capture on a stale location even when the players stand together", () => {
    const g = duel();
    // both were last reported at t=0; by t=60 those samples are far too old
    expect(attemptCapture(g, "k1", "s1", NOW + 60 * SEC).outcome).toMatchObject({
      status: "rejected",
      reason: "stale_location",
    });
  });

  it("refuses captures while the match is not active", () => {
    const g = pauseGame(duel(), "s1", NOW + 1 * SEC);
    expect(attemptCapture(g, "k1", "s1", NOW + 2 * SEC).outcome).toEqual({
      status: "rejected",
      reason: "match_not_active",
    });
    expect(attemptCapture(buildLobby(), "k1", "s1", NOW).outcome).toMatchObject({
      reason: "match_not_active",
    });
  });

  it("rejects survivors trying to capture and unknown players", () => {
    const g = duel();
    expect(attemptCapture(g, "s1", "k1", NOW + SEC).outcome).toMatchObject({ reason: "not_a_killer" });
    expect(attemptCapture(g, "k1", "nobody", NOW + SEC).outcome).toMatchObject({
      reason: "unknown_player",
    });
  });
});

// ------------------------------------------------------------ red zone through the game

describe("red-zone elimination through the game engine", () => {
  it("warns the player privately, then eliminates publicly after the grace period", () => {
    let g = activeGame({ config: ELIMINATE }); // s1 stands 100 m from centre; zone shrinks to 75 m at t=60 s
    for (const t of [60, 62, 67, 72]) g = place(g, "s1", at(180, 100), t);
    expect(P(g, "s1").status).toBe("active");
    expect(P(g, "s1").redZone.status).toBe("warning");

    g = place(g, "s1", at(180, 100), 77);
    expect(P(g, "s1").status).toBe("eliminated");
    expect(g.match.phase).toBe("active"); // s2 is still in the game

    const s1Events = eventsFor("s1", g.events).map((e) => e.type);
    const k1Events = eventsFor("k1", g.events).map((e) => e.type);
    expect(s1Events).toContain("red_zone_entered");
    expect(s1Events).toContain("eliminated");
    expect(k1Events).toContain("eliminated");
    expect(k1Events).not.toContain("red_zone_entered"); // private to s1
  });

  it("clears the warning and tells only that player when they walk back to safety", () => {
    let g = activeGame({ config: ELIMINATE });
    for (const t of [60, 62]) g = place(g, "s1", at(180, 100), t);
    expect(P(g, "s1").redZone.status).toBe("warning");
    g = place(g, "s1", at(180, 60), 66); // 40 m in 4 s: a brisk walk, well inside the 75 m zone
    expect(P(g, "s1").redZone.status).toBe("safe");
    expect(P(g, "s1").redZone.graceElapsedMs).toBe(0);
    expect(eventsFor("s1", g.events).map((e) => e.type)).toContain("red_zone_cleared");
    expect(eventsFor("k1", g.events).map((e) => e.type)).not.toContain("red_zone_cleared");
  });

  it("with the default HP-drain penalty, warns, drains HP, then eliminates", () => {
    let g = activeGame(); // default: 15 s grace, then 5 HP/s
    for (const t of [60, 62, 67, 72, 77]) g = place(g, "s1", at(180, 100), t);
    expect(P(g, "s1").redZone.status).toBe("penalized");
    expect(eventsFor("s1", g.events).map((e) => e.type)).toContain("penalty_started");
    g = place(g, "s1", at(180, 100), 87);
    expect(P(g, "s1").redZone.hp).toBeCloseTo(50, 6);
    expect(P(g, "s1").status).toBe("active");
    g = place(g, "s1", at(180, 100), 97);
    expect(P(g, "s1").status).toBe("eliminated");
  });

  it("ends the match when the last survivor is eliminated", () => {
    let g = activeGame({
      config: ELIMINATE,
      roster: [
        { id: "k1", role: "killer", pos: [0, 10] },
        { id: "s1", role: "survivor", pos: [180, 100] },
      ],
    });
    for (const t of [60, 62, 67, 72, 77]) g = place(g, "s1", at(180, 100), t);
    expect(g.match.phase).toBe("ended");
    expect(g.match.endReason).toBe("no_survivors");
  });
});

// ------------------------------------------------------------ clock-driven events

describe("tick events (what the UI animates)", () => {
  it("emits zone warnings, shrinks, reveals and the timeout at the right server times", () => {
    let g = activeGame();
    for (let t = 1; t <= 180; t++) g = tickGame(g, NOW + t * SEC);

    const timeline = g.events.map((e) => {
      const detail = "phaseIndex" in e ? e.phaseIndex : "index" in e ? e.index : "";
      return `${e.type}${detail === "" ? "" : `:${detail}`}@${(e.atMs - NOW) / SEC}`;
    });
    expect(timeline).toEqual([
      "match_started@0",
      "zone_warning:1@40",
      "zone_shrunk:1@60",
      "zone_warning:2@100",
      "zone_shrunk:2@120",
      "reveal_started:1@120",
      "reveal_ended:1@135",
      "match_ended@180",
    ]);
    expect(g.match.endReason).toBe("timeout");
  });

  it("does not repeat events on repeated ticks", () => {
    let g = activeGame();
    g = tickGame(g, NOW + 60 * SEC);
    const n = g.events.length;
    g = tickGame(g, NOW + 60 * SEC);
    g = tickGame(g, NOW + 61 * SEC);
    expect(g.events.length).toBe(n);
  });

  it("drains the queue", () => {
    let g = tickGame(activeGame(), NOW + 60 * SEC);
    const drained = drainEvents(g);
    expect(drained.events.length).toBeGreaterThan(0);
    expect(drained.state.events).toEqual([]);
    g = drained.state;
    expect(g.eventSeq).toBe(drained.events.length);
  });
});

// ------------------------------------------------------------ safety controls

describe("safety controls", () => {
  it("anyone can emergency-pause, only the host resumes, and the clock stops meanwhile", () => {
    let g = activeGame();
    g = pauseGame(g, "s1", NOW + 10 * SEC);
    expect(g.match.phase).toBe("paused");
    expect(g.events.at(-1)).toMatchObject({ type: "match_paused", byPlayerId: "s1" });

    const idle = tickGame(g, NOW + 500 * SEC);
    expect(idle).toBe(g); // nothing happens while paused

    expect(() => resumeGame(g, "s1", NOW + 70 * SEC)).toThrow(GameRuleError);
    g = resumeGame(g, g.hostId, NOW + 70 * SEC);
    expect(g.match.phase).toBe("active");
    // 60 s were paused: at wall-clock 100 s only 40 s of match time has passed
    expect(currentZone(g.match, NOW + 100 * SEC)?.phaseIndex).toBe(0);
  });

  it("a pause does not count against a player's red-zone grace period", () => {
    let g = activeGame();
    for (const t of [60, 62]) g = place(g, "s1", at(180, 100), t);
    expect(P(g, "s1").redZone.status).toBe("warning");
    g = pauseGame(g, "k1", NOW + 63 * SEC);
    g = resumeGame(g, "k1", NOW + 600 * SEC); // long pause
    g = place(g, "s1", at(180, 100), 601); // first sample after the pause
    expect(P(g, "s1").status).toBe("active");
    expect(P(g, "s1").redZone.graceElapsedMs).toBeLessThanOrEqual(1_000);
  });

  it("leaving drops the player's location and can end the match", () => {
    let g = activeGame();
    g = leaveGame(g, "s1", NOW + 5 * SEC);
    expect(P(g, "s1").status).toBe("left");
    expect(P(g, "s1").sample).toBeNull();
    expect(g.events.at(-1)).toMatchObject({ type: "player_left", playerId: "s1" });
    expect(g.match.phase).toBe("active");

    g = leaveGame(g, "s2", NOW + 6 * SEC);
    expect(g.match.phase).toBe("ended");
    expect(g.match.endReason).toBe("no_survivors");
  });

  it("the host can end the match or cancel from the lobby", () => {
    const ended = endGame(activeGame(), "k1", NOW + 5 * SEC);
    expect(ended.match.endReason).toBe("host_ended");
    expect(endGame(buildLobby(), "k1", NOW).match.endReason).toBe("cancelled");
    expect(() => endGame(activeGame(), "s1", NOW)).toThrow(GameRuleError);
  });

});
