import { destinationPoint } from "../src/geo";
import type { ZonePhaseConfig } from "../src/geo/zones";
import {
  addPlayer,
  confirmSafety,
  createGame,
  ingestLocation,
  setReady,
  startGame,
  type GameConfig,
  type GameState,
  type PlayerState,
  type Role,
} from "../src/engine";
import type { LatLng, LocationReport } from "../src/shared/types";

export const CENTER: LatLng = { lat: 28.6139, lng: 77.209 };
export const OUTER = { center: CENTER, radiusM: 150 };
export const NOW = 1_700_000_000_000;
export const SEC = 1000;

/** 0–60 s full area, 60–120 s at 50%, 120–180 s at 25%. */
export const PHASES: readonly ZonePhaseConfig[] = [
  { radiusFraction: 1, holdSeconds: 60, warningSeconds: 0 },
  { radiusFraction: 0.5, holdSeconds: 60, warningSeconds: 20 },
  { radiusFraction: 0.25, holdSeconds: 60, warningSeconds: 20 },
];

/** One long phase: the safe zone never shrinks, so zone effects don't interfere. */
export const LONG_PHASES: readonly ZonePhaseConfig[] = [
  { radiusFraction: 1, holdSeconds: 600, warningSeconds: 0 },
];

/** Instant elimination after the grace period (the default penalty is HP drain). */
export const ELIMINATE: Partial<GameConfig> = {
  redZone: { graceSeconds: 15, confirmSamples: 2, penalty: { kind: "eliminate" }, maxStepMs: 10_000 },
};

export const at = (bearing: number, distanceM: number): LatLng =>
  destinationPoint(CENTER, bearing, distanceM);

export const report = (p: LatLng, accuracyM = 5, ageMs = 0): LocationReport => ({
  lat: p.lat,
  lng: p.lng,
  accuracyM,
  ageMs,
});

export const P = (state: GameState, id: string): PlayerState => {
  const p = state.players[id];
  if (!p) throw new Error(`no player ${id}`);
  return p;
};

/** Report a position for `id` at t seconds after NOW. */
export function place(
  state: GameState,
  id: string,
  p: LatLng,
  tSec: number,
  accuracyM = 5,
): GameState {
  return ingestLocation(state, id, report(p, accuracyM), NOW + tSec * SEC).state;
}

/** Re-report every player's current position at t seconds (keeps samples fresh). */
export function touch(state: GameState, tSec: number, except: string[] = []): GameState {
  let s = state;
  for (const p of Object.values(state.players)) {
    if (p.sample && !except.includes(p.id))
      s = place(s, p.id, { lat: p.sample.lat, lng: p.sample.lng }, tSec, p.sample.accuracyM);
  }
  return s;
}

export interface RosterEntry {
  id: string;
  role: Role;
  pos: [bearing: number, distanceM: number];
}

export const DEFAULT_ROSTER: RosterEntry[] = [
  { id: "k1", role: "killer", pos: [0, 100] },
  // Not mirrored against s2 (270°), so no two players share a latitude and leak checks stay exact.
  { id: "k2", role: "killer", pos: [110, 100] },
  { id: "s1", role: "survivor", pos: [180, 100] },
  { id: "s2", role: "survivor", pos: [270, 100] },
];

/** Lobby with everyone placed inside the arena at t=0. Host is the first roster entry. */
export function buildLobby(
  opts: {
    roster?: RosterEntry[];
    ready?: boolean;
    safety?: boolean;
    phases?: readonly ZonePhaseConfig[];
    config?: Partial<GameConfig>;
  } = {},
): GameState {
  const roster = opts.roster ?? DEFAULT_ROSTER;
  const [host, ...rest] = roster;
  if (!host) throw new Error("empty roster");
  let s = createGame({
    hostId: host.id,
    hostName: host.id,
    hostRole: host.role,
    outer: OUTER,
    phases: opts.phases ?? PHASES,
    ...(opts.config ? { config: opts.config } : {}),
  });
  for (const r of rest) s = addPlayer(s, { id: r.id, name: r.id, role: r.role });
  for (const r of roster) {
    s = place(s, r.id, at(r.pos[0], r.pos[1]), 0);
    if (opts.ready ?? true) s = setReady(s, r.id, true);
  }
  if (opts.safety ?? true) s = confirmSafety(s, host.id);
  return s;
}

/** Started match at t=0 (host = first roster entry). */
export function activeGame(opts: Parameters<typeof buildLobby>[0] = {}): GameState {
  const lobby = buildLobby(opts);
  return startGame(lobby, lobby.hostId, NOW);
}
