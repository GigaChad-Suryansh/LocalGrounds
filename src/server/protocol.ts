import type { LocationReport } from "../shared/types";
import { RADIUS_PRESETS_M } from "../geo/zones";
import type {
  GameEvent,
  KillerFacingOutcome,
  Role,
  StartEvaluation,
  ViewerSnapshot,
} from "../engine";

// ------------------------------------------------------------------ client -> server

export type ClientMessage =
  | {
      t: "create";
      name: string;
      role: Role;
      radiusM: number;
      consent: true;
      /** The host's current GPS position becomes the arena centre. */
      location: LocationReport;
    }
  | { t: "join"; code: string; name: string; role: Role; consent: true }
  | { t: "resume"; token: string }
  | { t: "location"; report: LocationReport }
  | { t: "ready"; ready: boolean }
  | { t: "configure"; radiusM?: number; captureRadiusM?: number }
  | { t: "confirm_safety" }
  | { t: "start" }
  /** Note: no killer id. The server knows who is asking from the connection. */
  | { t: "capture"; survivorId: string }
  | { t: "pause" }
  | { t: "resume_match" }
  | { t: "end" }
  | { t: "leave" };

// ------------------------------------------------------------------ server -> client

export type ErrorCode =
  | "bad_message"
  | "not_in_room"
  | "already_in_room"
  | "room_not_found"
  | "room_full"
  | "already_started"
  | "server_full"
  | "invalid_token"
  | "bad_location"
  | "rate_limited"
  | "rule_violation"
  | "internal";

export interface RoomInfo {
  code: string;
  hostId: string;
  maxPlayers: number;
  radiusPresetsM: number[];
  captureRadiusM: number;
  /** Reveal cadence, so the UI can draw progress bars. */
  revealIntervalMs: number;
  revealDurationMs: number;
}

export type ServerMessage =
  | { t: "welcome"; token: string; playerId: string; code: string }
  | { t: "snapshot"; snapshot: ViewerSnapshot; room: RoomInfo; startCheck?: StartEvaluation }
  | { t: "events"; events: GameEvent[] }
  | { t: "capture_result"; outcome: KillerFacingOutcome }
  | { t: "location_ack"; accepted: boolean; issues: string[]; rateLimited?: boolean }
  | { t: "error"; code: ErrorCode; message: string }
  | { t: "left" };

// ------------------------------------------------------------------ parsing

export type ParseResult = { ok: true; msg: ClientMessage } | { ok: false; message: string };

const fail = (message: string): ParseResult => ({ ok: false, message });
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRole = (v: unknown): v is Role => v === "killer" || v === "survivor";

export const NAME_MAX = 20;

/** Strip control characters and angle brackets; clients must still escape names when rendering. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length >= 1 && s.length <= NAME_MAX ? s : null;
}

function parseReport(v: unknown): LocationReport | null {
  if (!isObj(v)) return null;
  const { lat, lng, accuracyM, ageMs } = v;
  if (!isNum(lat) || !isNum(lng) || !isNum(accuracyM)) return null;
  if (ageMs !== undefined && !isNum(ageMs)) return null;
  return ageMs === undefined ? { lat, lng, accuracyM } : { lat, lng, accuracyM, ageMs };
}

const isPreset = (n: unknown): n is number =>
  isNum(n) && (RADIUS_PRESETS_M as readonly number[]).includes(n);

/** Validate untrusted JSON from a client. Never throws. */
export function parseClientMessage(raw: unknown): ParseResult {
  if (!isObj(raw) || typeof raw.t !== "string") return fail("Message must be an object with a type.");

  switch (raw.t) {
    case "create": {
      const name = cleanName(raw.name);
      const location = parseReport(raw.location);
      if (!name) return fail(`Name must be 1–${NAME_MAX} characters.`);
      if (!isRole(raw.role)) return fail("Role must be killer or survivor.");
      if (!isPreset(raw.radiusM))
        return fail(`Radius must be one of ${RADIUS_PRESETS_M.join(", ")} m.`);
      if (raw.consent !== true) return fail("Location consent is required.");
      if (!location) return fail("A valid location is required to create a room.");
      return { ok: true, msg: { t: "create", name, role: raw.role, radiusM: raw.radiusM, consent: true, location } };
    }
    case "join": {
      const name = cleanName(raw.name);
      const code = typeof raw.code === "string" ? raw.code.trim().toUpperCase() : "";
      if (!/^[A-Z0-9]{5}$/.test(code)) return fail("Room code must be 5 letters/digits.");
      if (!name) return fail(`Name must be 1–${NAME_MAX} characters.`);
      if (!isRole(raw.role)) return fail("Role must be killer or survivor.");
      if (raw.consent !== true) return fail("Location consent is required.");
      return { ok: true, msg: { t: "join", code, name, role: raw.role, consent: true } };
    }
    case "resume": {
      if (typeof raw.token !== "string" || !/^[a-f0-9]{32}$/.test(raw.token))
        return fail("Invalid token format.");
      return { ok: true, msg: { t: "resume", token: raw.token } };
    }
    case "location": {
      const report = parseReport(raw.report);
      if (!report) return fail("Invalid location report.");
      return { ok: true, msg: { t: "location", report } };
    }
    case "ready": {
      if (typeof raw.ready !== "boolean") return fail("ready must be true or false.");
      return { ok: true, msg: { t: "ready", ready: raw.ready } };
    }
    case "configure": {
      const msg: ClientMessage = { t: "configure" };
      if (raw.radiusM !== undefined) {
        if (!isPreset(raw.radiusM))
          return fail(`Radius must be one of ${RADIUS_PRESETS_M.join(", ")} m.`);
        msg.radiusM = raw.radiusM;
      }
      if (raw.captureRadiusM !== undefined) {
        if (!isNum(raw.captureRadiusM)) return fail("captureRadiusM must be a number.");
        msg.captureRadiusM = raw.captureRadiusM;
      }
      return { ok: true, msg };
    }
    case "capture": {
      if (typeof raw.survivorId !== "string" || !/^[A-Za-z0-9_]{1,32}$/.test(raw.survivorId))
        return fail("Invalid survivor id.");
      return { ok: true, msg: { t: "capture", survivorId: raw.survivorId } };
    }
    case "confirm_safety":
    case "start":
    case "pause":
    case "resume_match":
    case "end":
    case "leave":
      return { ok: true, msg: { t: raw.t } };
    default:
      return fail("Unknown message type.");
  }
}
