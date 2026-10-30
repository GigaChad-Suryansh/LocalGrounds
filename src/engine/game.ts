import type { Circle, LocationReport, LocationSample } from "../shared/types";
import { classifyContainment } from "../geo/boundary";
import {
  checkSample,
  isSuspiciousJump,
  DEFAULT_FRESHNESS,
  type FreshnessPolicy,
  type SampleIssue,
} from "../geo/freshness";
import { RADIUS_PRESETS_M, type ZonePhaseConfig } from "../geo/zones";
import {
  evaluateCapture,
  DEFAULT_CAPTURE,
  type CaptureConfig,
  type CaptureOutcome,
  type CaptureTracker,
} from "./capture";
import type { Audience, GameEvent, GameEventBody } from "./events";
import {
  createMatch,
  currentZone,
  endMatch,
  pauseMatch,
  resumeMatch,
  startMatch,
  tickMatch,
  type MatchCore,
  type MatchEndReason,
} from "./match";
import { createPlayer, type PlayerState, type Role } from "./players";
import { DEFAULT_RED_ZONE, updateRedZone, type RedZoneConfig } from "./redZone";
import { DEFAULT_REVEAL, revealState, validateRevealConfig, type RevealConfig } from "./reveal";
import { computeZoneState } from "./schedule";

export class GameRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameRuleError";
  }
}

export interface GameConfig {
  capture: CaptureConfig;
  redZone: RedZoneConfig;
  reveal: RevealConfig;
  freshness: FreshnessPolicy;
  /** Same-role players always see each other while the match is active. */
  teamVisibility: boolean;
  minKillers: number;
  minSurvivors: number;
}

export const DEFAULT_GAME_CONFIG: GameConfig = {
  capture: DEFAULT_CAPTURE,
  redZone: DEFAULT_RED_ZONE,
  reveal: DEFAULT_REVEAL,
  freshness: DEFAULT_FRESHNESS,
  teamVisibility: true,
  minKillers: 1,
  minSurvivors: 1,
};

export interface GameState {
  match: MatchCore;
  config: GameConfig;
  hostId: string;
  /** Host has confirmed the area is safe and permitted. Required to start. */
  safetyConfirmed: boolean;
  players: Record<string, PlayerState>;
  captureTracker: CaptureTracker;
  /** What the last tick saw, so transitions can be turned into events. */
  observed: {
    phaseIndex: number;
    warningActive: boolean;
    revealActive: boolean;
    revealIndex: number;
  };
  events: GameEvent[];
  eventSeq: number;
}

// ---------------------------------------------------------------- helpers

const MAX_REPORT_AGE_MS = 10 * 60_000;

function emit(state: GameState, atMs: number, audience: Audience, body: GameEventBody): GameState {
  const seq = state.eventSeq + 1;
  const event = { seq, atMs, audience, ...body } as GameEvent;
  return { ...state, eventSeq: seq, events: [...state.events, event] };
}

const putPlayer = (state: GameState, p: PlayerState): GameState => ({
  ...state,
  players: { ...state.players, [p.id]: p },
});

function requirePlayer(state: GameState, id: string): PlayerState {
  const p = state.players[id];
  if (!p) throw new GameRuleError(`Unknown player "${id}".`);
  return p;
}

function finishIfDone(state: GameState, nowMs: number, survivorReason: MatchEndReason): GameState {
  if (state.match.phase !== "active") return state;
  const active = Object.values(state.players).filter((p) => p.status === "active");
  const survivors = active.filter((p) => p.role === "survivor").length;
  const killers = active.filter((p) => p.role === "killer").length;
  let reason: MatchEndReason | null = null;
  if (survivors === 0) reason = survivorReason;
  else if (killers === 0) reason = "no_killers";
  if (!reason) return state;
  const match = endMatch(state.match, nowMs, reason);
  return emit({ ...state, match }, nowMs, "all", { type: "match_ended", reason });
}

// ---------------------------------------------------------------- lobby

export function createGame(opts: {
  hostId: string;
  hostName: string;
  hostRole?: Role;
  outer: Circle;
  phases: readonly ZonePhaseConfig[];
  config?: Partial<GameConfig>;
}): GameState {
  const config: GameConfig = { ...DEFAULT_GAME_CONFIG, ...opts.config };
  const revealErrors = validateRevealConfig(config.reveal);
  if (revealErrors.length > 0) throw new GameRuleError(revealErrors.join(" "));
  const host = createPlayer(opts.hostId, opts.hostName, opts.hostRole ?? "killer");
  return {
    match: createMatch(opts.outer, opts.phases),
    config,
    hostId: opts.hostId,
    safetyConfirmed: false,
    players: { [host.id]: host },
    captureTracker: {},
    observed: { phaseIndex: 0, warningActive: false, revealActive: false, revealIndex: 0 },
    events: [],
    eventSeq: 0,
  };
}

export function addPlayer(
  state: GameState,
  p: { id: string; name: string; role: Role },
): GameState {
  if (state.match.phase !== "lobby")
    throw new GameRuleError("Players can only join before the match starts.");
  if (state.players[p.id]) throw new GameRuleError(`Player "${p.id}" already joined.`);
  return putPlayer(state, createPlayer(p.id, p.name, p.role));
}

export function setReady(state: GameState, playerId: string, ready: boolean): GameState {
  const p = requirePlayer(state, playerId);
  if (state.match.phase !== "lobby") throw new GameRuleError("Ready can only change in the lobby.");
  return putPlayer(state, { ...p, ready });
}

export const CAPTURE_RADIUS_RANGE_M = { min: 5, max: 50 } as const;

/**
 * Host-only lobby settings. Changing the arena size invalidates the host's
 * safety confirmation: they must re-confirm the (new) area is safe and permitted.
 */
export function configureArena(
  state: GameState,
  byPlayerId: string,
  opts: { radiusM?: number; captureRadiusM?: number },
): GameState {
  if (byPlayerId !== state.hostId)
    throw new GameRuleError("Only the host can change the arena settings.");
  if (state.match.phase !== "lobby")
    throw new GameRuleError("Arena settings can only change in the lobby.");

  let next = state;
  if (opts.radiusM !== undefined) {
    if (!(RADIUS_PRESETS_M as readonly number[]).includes(opts.radiusM))
      throw new GameRuleError(`Radius must be one of ${RADIUS_PRESETS_M.join(", ")} m.`);
    if (opts.radiusM !== state.match.outer.radiusM)
      next = {
        ...next,
        match: { ...next.match, outer: { ...next.match.outer, radiusM: opts.radiusM } },
        safetyConfirmed: false,
      };
  }
  if (opts.captureRadiusM !== undefined) {
    const { min, max } = CAPTURE_RADIUS_RANGE_M;
    if (!(opts.captureRadiusM >= min && opts.captureRadiusM <= max))
      throw new GameRuleError(`Capture radius must be between ${min} and ${max} m.`);
    next = {
      ...next,
      config: {
        ...next.config,
        capture: { ...next.config.capture, captureRadiusM: opts.captureRadiusM },
      },
    };
  }
  return next;
}

/** Hand the host role to another active player (used when the host leaves). */
export function transferHost(state: GameState, newHostId: string): GameState {
  const p = requirePlayer(state, newHostId);
  if (p.status !== "active") throw new GameRuleError("The new host must be an active player.");
  return {
    ...state,
    hostId: newHostId,
    // A new host must personally confirm the area before the match can start.
    safetyConfirmed: state.match.phase === "lobby" ? false : state.safetyConfirmed,
  };
}

export function confirmSafety(state: GameState, byPlayerId: string): GameState {
  if (byPlayerId !== state.hostId)
    throw new GameRuleError("Only the host can confirm the area is safe and permitted.");
  return { ...state, safetyConfirmed: true };
}

export type EligibilityIssue =
  | "no_location"
  | "stale_location"
  | "inaccurate_location"
  | "outside_start_area";

export interface PlayerEligibility {
  playerId: string;
  ready: boolean;
  eligible: boolean;
  issues: EligibilityIssue[];
}

export function playerEligibility(
  state: GameState,
  p: PlayerState,
  nowMs: number,
): PlayerEligibility {
  const issues: EligibilityIssue[] = [];
  if (!p.sample) {
    issues.push("no_location");
  } else {
    const check = checkSample(p.sample, nowMs, state.config.freshness);
    if (check.issues.includes("stale")) issues.push("stale_location");
    if (check.issues.includes("inaccurate")) issues.push("inaccurate_location");
    if (check.issues.includes("invalid_coordinates") || check.issues.includes("invalid_accuracy"))
      issues.push("no_location");
    if (classifyContainment(p.sample, state.match.outer) === "outside")
      issues.push("outside_start_area");
  }
  return { playerId: p.id, ready: p.ready, eligible: issues.length === 0, issues };
}

export type StartBlocker =
  | "safety_not_confirmed"
  | "not_enough_killers"
  | "not_enough_survivors"
  | "players_not_ready"
  | "players_ineligible";

export interface StartEvaluation {
  canStart: boolean;
  blockers: StartBlocker[];
  players: PlayerEligibility[];
}

export function evaluateStart(state: GameState, nowMs: number): StartEvaluation {
  const roster = Object.values(state.players).filter((p) => p.status === "active");
  const players = roster.map((p) => playerEligibility(state, p, nowMs));
  const blockers: StartBlocker[] = [];
  if (!state.safetyConfirmed) blockers.push("safety_not_confirmed");
  if (roster.filter((p) => p.role === "killer").length < state.config.minKillers)
    blockers.push("not_enough_killers");
  if (roster.filter((p) => p.role === "survivor").length < state.config.minSurvivors)
    blockers.push("not_enough_survivors");
  if (players.some((p) => !p.ready)) blockers.push("players_not_ready");
  if (players.some((p) => !p.eligible)) blockers.push("players_ineligible");
  return { canStart: blockers.length === 0, blockers, players };
}

export function startGame(state: GameState, byPlayerId: string, nowMs: number): GameState {
  if (byPlayerId !== state.hostId) throw new GameRuleError("Only the host can start the match.");
  const evaluation = evaluateStart(state, nowMs);
  if (!evaluation.canStart)
    throw new GameRuleError(`Cannot start: ${evaluation.blockers.join(", ")}.`);
  const next = {
    ...state,
    match: startMatch(state.match, nowMs),
    observed: { phaseIndex: 0, warningActive: false, revealActive: false, revealIndex: 0 },
  };
  return emit(next, nowMs, "all", { type: "match_started" });
}

// ---------------------------------------------------------------- safety controls

/** Any participant can trigger an emergency pause. */
export function pauseGame(state: GameState, byPlayerId: string, nowMs: number): GameState {
  const p = requirePlayer(state, byPlayerId);
  if (p.status === "left") throw new GameRuleError("Players who left cannot pause the match.");
  const next = { ...state, match: pauseMatch(state.match, nowMs) };
  return emit(next, nowMs, "all", { type: "match_paused", byPlayerId });
}

/** Only the host resumes, so a pause called for safety isn't undone by a prank. */
export function resumeGame(state: GameState, byPlayerId: string, nowMs: number): GameState {
  if (byPlayerId !== state.hostId) throw new GameRuleError("Only the host can resume the match.");
  const match = resumeMatch(state.match, nowMs);
  // The pause must not count towards anyone's red-zone grace period.
  const players: Record<string, PlayerState> = {};
  for (const [id, p] of Object.entries(state.players))
    players[id] = { ...p, redZone: { ...p.redZone, lastUpdateMs: nowMs } };
  let next = emit({ ...state, match, players }, nowMs, "all", { type: "match_resumed" });
  next = finishIfDone(next, nowMs, "no_survivors");
  return next;
}

export function endGame(state: GameState, byPlayerId: string, nowMs: number): GameState {
  if (byPlayerId !== state.hostId) throw new GameRuleError("Only the host can end the match.");
  const match = endMatch(state.match, nowMs, state.match.phase === "lobby" ? "cancelled" : "host_ended");
  return emit({ ...state, match }, nowMs, "all", {
    type: "match_ended",
    reason: match.endReason ?? "host_ended",
  });
}

export function leaveGame(state: GameState, playerId: string, nowMs: number): GameState {
  const p = requirePlayer(state, playerId);
  if (p.status === "left") return state;
  // Drop the location immediately: a player who left is no longer tracked.
  let next = putPlayer(state, { ...p, status: "left", sample: null, suspicious: false });
  next = emit(next, nowMs, "all", { type: "player_left", playerId });
  return finishIfDone(next, nowMs, "no_survivors");
}

// ---------------------------------------------------------------- location + red zone

export interface IngestResult {
  state: GameState;
  accepted: boolean;
  /** Problems with this report, so the client can tell the player (e.g. "GPS inaccurate"). */
  issues: SampleIssue[];
}

/**
 * Accept a location report. The server stamps the sample time itself; the
 * client cannot declare a position "fresh". Out-of-order or malformed reports
 * are rejected, implausible jumps are accepted but flagged `suspicious`
 * (so they can't be used for captures or red-zone penalties).
 */
export function ingestLocation(
  state: GameState,
  playerId: string,
  report: LocationReport,
  nowMs: number,
): IngestResult {
  const p = state.players[playerId];
  if (!p || p.status === "left") return { state, accepted: false, issues: [] };

  const rawAge = report.ageMs ?? 0;
  const ageMs = Number.isFinite(rawAge) ? Math.min(Math.max(rawAge, 0), MAX_REPORT_AGE_MS) : 0;
  const sample: LocationSample = {
    lat: report.lat,
    lng: report.lng,
    accuracyM: report.accuracyM,
    timestampMs: nowMs - ageMs,
  };

  const check = checkSample(sample, nowMs, state.config.freshness);
  const malformed = check.issues.some(
    (i) => i === "invalid_coordinates" || i === "invalid_accuracy" || i === "from_future",
  );
  if (malformed) return { state, accepted: false, issues: check.issues };
  if (p.sample && sample.timestampMs <= p.sample.timestampMs)
    return { state, accepted: false, issues: check.issues };

  const suspicious = p.sample ? isSuspiciousJump(p.sample, sample, state.config.freshness) : false;
  let next = putPlayer(state, { ...p, sample, suspicious });

  if (next.match.phase === "active" && p.status === "active") {
    const zone = currentZone(next.match, nowMs);
    if (zone) {
      const r = updateRedZone(
        p.redZone,
        suspicious ? undefined : sample,
        zone.safeZone,
        nowMs,
        state.config.redZone,
        state.config.freshness,
      );
      let updated: PlayerState = { ...(next.players[playerId] as PlayerState), redZone: r.tracker };
      if (r.event === "eliminated") updated = { ...updated, status: "eliminated" };
      next = putPlayer(next, updated);

      const only: Audience = [playerId];
      if (r.event === "entered_red")
        next = emit(next, nowMs, only, {
          type: "red_zone_entered",
          graceMs: state.config.redZone.graceSeconds * 1000,
        });
      else if (r.event === "returned_safe")
        next = emit(next, nowMs, only, { type: "red_zone_cleared" });
      else if (r.event === "penalty_started")
        next = emit(next, nowMs, only, { type: "penalty_started" });
      else if (r.event === "eliminated") {
        next = emit(next, nowMs, "all", { type: "eliminated", playerId, cause: "red_zone" });
        next = finishIfDone(next, nowMs, "no_survivors");
      }
    }
  }
  return { state: next, accepted: true, issues: check.issues };
}

// ---------------------------------------------------------------- capture

/**
 * A killer asks to tag a survivor. The request carries ONLY the two ids: the
 * server decides using the samples it already holds. Callers must authenticate
 * that `killerId` is the requesting player.
 */
export function attemptCapture(
  state: GameState,
  killerId: string,
  survivorId: string,
  nowMs: number,
): { state: GameState; outcome: CaptureOutcome } {
  const killer = state.players[killerId];
  const survivor = state.players[survivorId];
  if (!killer || !survivor)
    return { state, outcome: { status: "rejected", reason: "unknown_player" } };
  if (state.match.phase !== "active")
    return { state, outcome: { status: "rejected", reason: "match_not_active" } };

  const { tracker, outcome } = evaluateCapture(
    state.captureTracker,
    killer,
    survivor,
    nowMs,
    state.config.capture,
    state.config.freshness,
  );
  let next: GameState = { ...state, captureTracker: tracker };

  if (outcome.status === "captured") {
    next = putPlayer(next, { ...survivor, status: "captured" });
    next = emit(next, nowMs, "all", { type: "captured", killerId, survivorId });
    next = finishIfDone(next, nowMs, "all_captured");
  }
  return { state: next, outcome };
}

// ---------------------------------------------------------------- clock

/** Call regularly (e.g. every second) on the server to turn time passing into events. */
export function tickGame(state: GameState, nowMs: number): GameState {
  const schedule = state.match.schedule;
  if (state.match.phase !== "active" || !schedule) return state;

  const ticked = tickMatch(state.match, nowMs);
  if (ticked.phase === "ended")
    return emit({ ...state, match: ticked }, nowMs, "all", {
      type: "match_ended",
      reason: ticked.endReason ?? "timeout",
    });

  const zone = computeZoneState(state.match.outer, schedule, nowMs);
  const reveal = revealState(schedule, nowMs, state.config.reveal);
  const obs = state.observed;
  let next = state;

  const shrunk = zone.phaseIndex > obs.phaseIndex;
  if (shrunk) next = emit(next, nowMs, "all", { type: "zone_shrunk", phaseIndex: zone.phaseIndex });
  if (zone.warningActive && (!obs.warningActive || shrunk))
    next = emit(next, nowMs, "all", { type: "zone_warning", phaseIndex: zone.phaseIndex + 1 });
  if (reveal.active && !obs.revealActive)
    next = emit(next, nowMs, "all", {
      type: "reveal_started",
      index: reveal.index,
      durationMs: state.config.reveal.durationMs,
    });
  if (!reveal.active && obs.revealActive)
    next = emit(next, nowMs, "all", { type: "reveal_ended", index: obs.revealIndex });

  return {
    ...next,
    observed: {
      phaseIndex: zone.phaseIndex,
      warningActive: zone.warningActive,
      revealActive: reveal.active,
      revealIndex: reveal.active ? reveal.index : obs.revealIndex,
    },
  };
}

/** Take the queued events (e.g. to broadcast them) and clear the queue. */
export function drainEvents(state: GameState): { state: GameState; events: GameEvent[] } {
  return { state: { ...state, events: [] }, events: state.events };
}
