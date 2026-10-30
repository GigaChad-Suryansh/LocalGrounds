import type { LocationSample } from "../shared/types";
import { initialRedZoneTracker, type RedZoneTracker } from "./redZone";

export type Role = "killer" | "survivor";
export type PlayerStatus = "active" | "captured" | "eliminated" | "left";

export interface PlayerState {
  id: string;
  name: string;
  role: Role;
  status: PlayerStatus;
  ready: boolean;
  /** Latest server-stamped sample. Never sent to other players directly. */
  sample: LocationSample | null;
  /** True when the latest sample made an implausible jump from the previous one. */
  suspicious: boolean;
  redZone: RedZoneTracker;
}

export function createPlayer(id: string, name: string, role: Role): PlayerState {
  return {
    id,
    name,
    role,
    status: "active",
    ready: false,
    sample: null,
    suspicious: false,
    redZone: initialRedZoneTracker(),
  };
}
