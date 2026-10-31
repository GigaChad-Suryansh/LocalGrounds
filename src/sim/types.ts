import type { Role } from "../engine";
import type { ViewerSnapshot } from "../engine";
import type { ClientMessage } from "../server";
import type { LatLng } from "../shared/types";
import type { Rng } from "./rng";

/** How a simulated phone's GPS misbehaves. Defaults describe a decent outdoor receiver. */
export interface GpsModel {
  /** Standard deviation of position noise, metres. */
  sigmaM: number;
  /** Accuracy radius the phone reports. */
  accuracyM: number;
  /** Chance a given second produces no report at all. */
  dropout: number;
  /** Chance a report arrives with an old fix (ageMs 20 s). */
  staleChance: number;
  /** Periodic bad patches (urban canyon): every `everyS` seconds the accuracy is `accuracyM` for `lengthS`. */
  burst?: { everyS: number; lengthS: number; accuracyM: number; sigmaM: number };
  /** From `atS` for `forS` seconds the phone reports a spoofed spot `jumpM` away. */
  spoof?: { atS: number; forS: number; jumpM: number };
}

export const GOOD_GPS: GpsModel = { sigmaM: 3, accuracyM: 8, dropout: 0.02, staleChance: 0.01 };

export interface BotCtx {
  bot: SimBot;
  bots: readonly SimBot[];
  snapshot: ViewerSnapshot | null;
  tSec: number;
  rng: Rng;
  /** Radius of the safe zone the players can currently see. */
  safeRadiusM: number;
  center: LatLng;
}

export interface Move {
  /** Where to walk, or null to stand still. */
  to: LatLng | null;
}
export type Behavior = (ctx: BotCtx) => Move;

export interface BotSpec {
  name: string;
  role: Role;
  /** Offset from the arena centre: bearing (deg) and distance (m). */
  start: { bearing: number; distanceM: number };
  speedMps: number;
  behavior: Behavior;
  gps?: Partial<GpsModel>;
}

export interface SimBot {
  spec: BotSpec;
  gps: GpsModel;
  playerId: string;
  token: string;
  code: string;
  truth: LatLng;
  /** Truth position at the start of each simulated second (index = second). */
  history: LatLng[];
  connected: boolean;
  snapshot: ViewerSnapshot | null;
  /** Last revealed position of each other player this bot saw (for chasing). */
  seen: Record<string, LatLng>;
  /** Recently reported latitudes, kept to detect leaks. */
  reportedLats: string[];
}

export type { ClientMessage };
