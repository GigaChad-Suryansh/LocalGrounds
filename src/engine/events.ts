import type { MatchEndReason } from "./match";

/** "all" = everyone in the match; otherwise only the listed player ids. */
export type Audience = "all" | readonly string[];

/**
 * Game events are the single source for UI feedback (animations, sounds, haptics).
 * They never contain coordinates.
 */
export type GameEventBody =
  | { type: "match_started" }
  | { type: "match_paused"; byPlayerId: string }
  | { type: "match_resumed" }
  | { type: "match_ended"; reason: MatchEndReason }
  | { type: "zone_warning"; phaseIndex: number }
  | { type: "zone_shrunk"; phaseIndex: number }
  | { type: "reveal_started"; index: number; durationMs: number }
  | { type: "reveal_ended"; index: number }
  | { type: "captured"; killerId: string; survivorId: string }
  | { type: "eliminated"; playerId: string; cause: "red_zone" }
  | { type: "player_left"; playerId: string }
  // private to the affected player:
  | { type: "red_zone_entered"; graceMs: number }
  | { type: "red_zone_cleared" }
  | { type: "penalty_started" };

export type GameEvent = { seq: number; atMs: number; audience: Audience } & GameEventBody;

export function eventsFor(viewerId: string, events: readonly GameEvent[]): GameEvent[] {
  return events.filter((e) => e.audience === "all" || e.audience.includes(viewerId));
}
