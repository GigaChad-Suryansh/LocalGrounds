import type { Circle } from "../shared/types";
import { checkSample, type SampleIssue } from "../geo/freshness";
import type { GameState, PlayerEligibility } from "./game";
import { GameRuleError, playerEligibility } from "./game";
import type { MatchEndReason, MatchPhase } from "./match";
import { currentZone } from "./match";
import type { PlayerState, PlayerStatus, Role } from "./players";
import { revealState, type RevealState } from "./reveal";
import type { ZoneState } from "./schedule";
import type { LocationSample } from "../shared/types";

export interface VisibilityContext {
  matchPhase: MatchPhase;
  revealActive: boolean;
  teamVisibility: boolean;
}

/**
 * THE rule for who may see whose position. Every payload sent to a client
 * must be built through this (see `projectForViewer`).
 *
 *  - Only while the match is active (lobby, paused and ended show nobody's position).
 *  - Only between active players (captured/eliminated/left see and are seen by no one).
 *  - Teammates see each other (if enabled).
 *  - Everyone else is hidden, except during a reveal window.
 */
export function canSeePosition(
  viewer: PlayerState,
  target: PlayerState,
  ctx: VisibilityContext,
): boolean {
  if (viewer.id === target.id) return true;
  if (ctx.matchPhase !== "active") return false;
  if (viewer.status !== "active" || target.status !== "active") return false;
  if (ctx.teamVisibility && viewer.role === target.role) return true;
  return ctx.revealActive;
}

export interface PositionView {
  lat: number;
  lng: number;
  accuracyM: number;
  ageMs: number;
}

export interface OtherPlayerView {
  id: string;
  name: string;
  role: Role;
  status: PlayerStatus;
  ready: boolean;
  /** Present only when the viewer is currently allowed to see it AND the signal is usable. */
  position: PositionView | null;
  /** True when the viewer may see this player but they have no usable location right now. */
  signalLost: boolean;
}

export interface SelfView {
  id: string;
  name: string;
  role: Role;
  status: PlayerStatus;
  ready: boolean;
  position: PositionView | null;
  /** Why the player's own location is unusable, if it is (drives the "GPS weak" UI). */
  locationIssues: Array<SampleIssue | "no_location">;
  suspicious: boolean;
  eligibility: PlayerEligibility;
  redZone: { status: string; hp: number; graceRemainingMs: number | null };
}

export interface ViewerSnapshot {
  serverTimeMs: number;
  matchPhase: MatchPhase;
  endReason: MatchEndReason | null;
  safetyConfirmed: boolean;
  outer: Circle;
  /** Zone state is public: everyone sees the safe zone and its countdown. */
  zone: ZoneState | null;
  reveal: RevealState | null;
  self: SelfView;
  others: OtherPlayerView[];
}

const toView = (s: LocationSample, nowMs: number): PositionView => ({
  lat: s.lat,
  lng: s.lng,
  accuracyM: s.accuracyM,
  ageMs: Math.max(0, nowMs - s.timestampMs),
});

/**
 * Build the ONLY data a given player's client may receive. Other players'
 * raw samples, red-zone trackers and suspicion flags are never copied in.
 */
export function projectForViewer(
  state: GameState,
  viewerId: string,
  nowMs: number,
): ViewerSnapshot {
  const viewer = state.players[viewerId];
  if (!viewer) throw new GameRuleError(`Unknown player "${viewerId}".`);

  const schedule = state.match.schedule;
  const reveal =
    schedule && state.match.phase !== "ended"
      ? revealState(schedule, nowMs, state.config.reveal)
      : null;
  const ctx: VisibilityContext = {
    matchPhase: state.match.phase,
    revealActive: reveal?.active ?? false,
    teamVisibility: state.config.teamVisibility,
  };

  const others: OtherPlayerView[] = Object.values(state.players)
    .filter((p) => p.id !== viewerId)
    .map((p) => {
      let position: PositionView | null = null;
      let signalLost = false;
      if (canSeePosition(viewer, p, ctx)) {
        if (p.sample && !p.suspicious && checkSample(p.sample, nowMs, state.config.freshness).ok)
          position = toView(p.sample, nowMs);
        else signalLost = true;
      }
      return {
        id: p.id,
        name: p.name,
        role: p.role,
        status: p.status,
        ready: p.ready,
        position,
        signalLost,
      };
    });

  const ownCheck = viewer.sample ? checkSample(viewer.sample, nowMs, state.config.freshness) : null;
  const tracker = viewer.redZone;
  const self: SelfView = {
    id: viewer.id,
    name: viewer.name,
    role: viewer.role,
    status: viewer.status,
    ready: viewer.ready,
    position: viewer.sample ? toView(viewer.sample, nowMs) : null,
    locationIssues: ownCheck ? ownCheck.issues : ["no_location"],
    suspicious: viewer.suspicious,
    eligibility: playerEligibility(state, viewer, nowMs),
    redZone: {
      status: tracker.status,
      hp: tracker.hp,
      graceRemainingMs:
        tracker.status === "warning"
          ? Math.max(0, state.config.redZone.graceSeconds * 1000 - tracker.graceElapsedMs)
          : null,
    },
  };

  return {
    serverTimeMs: nowMs,
    matchPhase: state.match.phase,
    endReason: state.match.endReason,
    safetyConfirmed: state.safetyConfirmed,
    outer: state.match.outer,
    zone: currentZone(state.match, nowMs),
    reveal,
    self,
    others,
  };
}
