import { describe, it, expect } from "vitest";
import {
  CAPTURE_RADIUS_RANGE_M,
  configureArena,
  confirmSafety,
  evaluateStart,
  GameRuleError,
  leaveGame,
  transferHost,
} from "../src/engine";
import { NOW, activeGame, buildLobby } from "./helpers";

describe("host-only arena settings", () => {
  it("lets the host pick a preset radius", () => {
    const g = configureArena(buildLobby(), "k1", { radiusM: 75 });
    expect(g.match.outer.radiusM).toBe(75);
  });

  it("rejects non-hosts, non-presets, and changes after the lobby", () => {
    expect(() => configureArena(buildLobby(), "s1", { radiusM: 75 })).toThrow(GameRuleError);
    expect(() => configureArena(buildLobby(), "k1", { radiusM: 123 })).toThrow(GameRuleError);
    expect(() => configureArena(activeGame(), "k1", { radiusM: 75 })).toThrow(GameRuleError);
  });

  it("changing the radius withdraws the safety confirmation; re-selecting the same one does not", () => {
    const lobby = buildLobby();
    expect(lobby.safetyConfirmed).toBe(true);
    expect(configureArena(lobby, "k1", { radiusM: 150 }).safetyConfirmed).toBe(true);

    const resized = configureArena(lobby, "k1", { radiusM: 300 });
    expect(resized.safetyConfirmed).toBe(false);
    expect(evaluateStart(resized, NOW + 1_000).blockers).toContain("safety_not_confirmed");
    expect(evaluateStart(confirmSafety(resized, "k1"), NOW + 1_000).blockers).not.toContain(
      "safety_not_confirmed",
    );
  });

  it("never changes the arena centre", () => {
    const lobby = buildLobby();
    expect(configureArena(lobby, "k1", { radiusM: 30 }).match.outer.center).toEqual(
      lobby.match.outer.center,
    );
  });

  it("bounds the capture radius", () => {
    const { min, max } = CAPTURE_RADIUS_RANGE_M;
    expect(configureArena(buildLobby(), "k1", { captureRadiusM: 10 }).config.capture.captureRadiusM).toBe(10);
    expect(() => configureArena(buildLobby(), "k1", { captureRadiusM: min - 1 })).toThrow(GameRuleError);
    expect(() => configureArena(buildLobby(), "k1", { captureRadiusM: max + 1 })).toThrow(GameRuleError);
    expect(() => configureArena(buildLobby(), "k1", { captureRadiusM: NaN })).toThrow(GameRuleError);
    // lock time: whole seconds within range, host only, lobby only
    expect(configureArena(buildLobby(), "k1", { lockSeconds: 6 }).config.capture.lockSeconds).toBe(6);
    for (const bad of [1, 11, 3.5, NaN])
      expect(() => configureArena(buildLobby(), "k1", { lockSeconds: bad })).toThrow(GameRuleError);
    expect(() => configureArena(buildLobby(), "s1", { lockSeconds: 6 })).toThrow(GameRuleError);
  });
});

describe("host transfer", () => {
  it("hands the role to an active player and requires them to re-confirm safety in the lobby", () => {
    const g = transferHost(buildLobby(), "s1");
    expect(g.hostId).toBe("s1");
    expect(g.safetyConfirmed).toBe(false);
  });

  it("keeps the confirmation once a match is running", () => {
    const g = transferHost(activeGame(), "s1");
    expect(g.hostId).toBe("s1");
    expect(g.safetyConfirmed).toBe(true);
  });

  it("refuses departed players and unknown ids", () => {
    const gone = leaveGame(buildLobby(), "s1", NOW);
    expect(() => transferHost(gone, "s1")).toThrow(GameRuleError);
    expect(() => transferHost(buildLobby(), "nobody")).toThrow(GameRuleError);
  });
});
