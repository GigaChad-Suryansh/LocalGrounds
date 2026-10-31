import type { ErrorCode, RoomInfo, ServerMessage } from "../../../src/server/protocol";
import type { KillerFacingOutcome, StartEvaluation, ViewerSnapshot } from "../../../src/engine";
import type { GpsStatus } from "../lib/gps";
import { captureResultFx, fxForEvent, type Fx, type FxContext, type FxDraft } from "../lib/fx";
import type { NetStatus } from "../net/connection";

export interface Session {
  token: string;
  playerId: string;
  code: string;
}

export interface ClientState {
  net: NetStatus;
  gps: GpsStatus;
  session: Session | null;
  snapshot: ViewerSnapshot | null;
  room: RoomInfo | null;
  startCheck: StartEvaluation | null;
  /** performance.now() when the latest snapshot arrived (countdowns tick down from here). */
  receivedAt: number;
  fx: Fx[];
  nextFxId: number;
  lastSeq: number;
  error: { id: number; code: ErrorCode; message: string } | null;
  captureResult: { id: number; outcome: KillerFacingOutcome } | null;
  locationAck: { accepted: boolean; issues: string[]; rateLimited: boolean } | null;
  /** True after the server dropped our token (so the landing screen can say why). */
  sessionExpired: boolean;
}

export const MAX_VISIBLE_FX = 3;

export const initialState = (): ClientState => ({
  net: "idle",
  gps: { state: "off" },
  session: null,
  snapshot: null,
  room: null,
  startCheck: null,
  receivedAt: 0,
  fx: [],
  nextFxId: 1,
  lastSeq: 0,
  error: null,
  captureResult: null,
  locationAck: null,
  sessionExpired: false,
});

export type Action =
  | { type: "net"; status: NetStatus }
  | { type: "gps"; status: GpsStatus }
  | { type: "server"; msg: ServerMessage; now: number }
  | { type: "fx_expire"; id: number }
  | { type: "clear_error" }
  | { type: "reset" };

function fxContext(s: ClientState): FxContext | null {
  const snap = s.snapshot;
  if (!snap) return null;
  const names: Record<string, string> = { [snap.self.id]: snap.self.name };
  for (const o of snap.others) names[o.id] = o.name;
  return { myId: snap.self.id, myRole: snap.self.role, names };
}

function pushFx(s: ClientState, draft: FxDraft): ClientState {
  const fx: Fx = { ...draft, id: s.nextFxId };
  return { ...s, nextFxId: s.nextFxId + 1, fx: [...s.fx, fx].slice(-MAX_VISIBLE_FX) };
}

function reduceServer(s: ClientState, msg: ServerMessage, now: number): ClientState {
  switch (msg.t) {
    case "welcome": {
      const sameSession = s.session?.playerId === msg.playerId;
      return {
        ...s,
        session: { token: msg.token, playerId: msg.playerId, code: msg.code },
        lastSeq: sameSession ? s.lastSeq : 0,
        sessionExpired: false,
      };
    }
    case "snapshot":
      return {
        ...s,
        snapshot: msg.snapshot,
        room: msg.room,
        startCheck: msg.startCheck ?? null,
        receivedAt: now,
      };
    case "events": {
      const ctx = fxContext(s);
      if (!ctx) return s;
      let next = s;
      for (const e of msg.events) {
        if (e.seq <= next.lastSeq) continue; // already shown (e.g. after a reconnect)
        next = { ...next, lastSeq: e.seq };
        const draft = fxForEvent(e, ctx);
        if (draft) next = pushFx(next, draft);
      }
      return next;
    }
    case "capture_result": {
      const next: ClientState = {
        ...s,
        captureResult: { id: (s.captureResult?.id ?? 0) + 1, outcome: msg.outcome },
      };
      const draft = captureResultFx(msg.outcome);
      return draft ? pushFx(next, draft) : next;
    }
    case "location_ack":
      return { ...s, locationAck: { accepted: msg.accepted, issues: msg.issues, rateLimited: msg.rateLimited ?? false } };
    case "error": {
      const error = { id: (s.error?.id ?? 0) + 1, code: msg.code, message: msg.message };
      if (msg.code === "invalid_token")
        return { ...s, error: null, session: null, snapshot: null, room: null, startCheck: null, sessionExpired: true };
      return { ...s, error };
    }
    case "left":
      return { ...initialState(), gps: s.gps, net: s.net };
  }
}

export function reduce(s: ClientState, a: Action): ClientState {
  switch (a.type) {
    case "net":
      return { ...s, net: a.status };
    case "gps":
      return { ...s, gps: a.status };
    case "server":
      return reduceServer(s, a.msg, a.now);
    case "fx_expire":
      return { ...s, fx: s.fx.filter((f) => f.id !== a.id) };
    case "clear_error":
      return { ...s, error: null };
    case "reset":
      return { ...initialState(), gps: s.gps, net: s.net };
  }
}

export interface Store {
  get(): ClientState;
  dispatch(a: Action): void;
  subscribe(fn: () => void): () => void;
}

export function createStore(): Store {
  let state = initialState();
  const subs = new Set<() => void>();
  return {
    get: () => state,
    dispatch(a) {
      const next = reduce(state, a);
      if (next === state) return;
      state = next;
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

/** Friendly wording for server error codes. */
export function errorText(code: ErrorCode, message: string): string {
  switch (code) {
    case "room_not_found":
      return "No room with that code. Check the letters and try again.";
    case "room_full":
      return "That room is full.";
    case "already_started":
      return "That match has already started.";
    case "server_full":
      return "The server is busy. Try again in a minute.";
    case "bad_location":
      return message;
    case "rate_limited":
      return "Slow down a little.";
    case "internal":
      return "Something went wrong on our side. Try again.";
    default:
      return message;
  }
}
