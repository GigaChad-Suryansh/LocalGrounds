import { signedDistanceToEdgeM } from "../../../src/geo/boundary";
import type { Circle, LatLng } from "../../../src/shared/types";

export interface Standing {
  text: string;
  tone: "ok" | "warn" | "bad";
}

/** Where the player stands relative to the arena and the current safe zone, in plain words. */
export function standing(pos: LatLng | null, outer: Circle, safe: Circle | null): Standing | null {
  if (!pos) return null;
  const outOfArena = signedDistanceToEdgeM(pos, outer);
  if (outOfArena > 0) return { text: `Outside the arena by ${Math.round(outOfArena)} m`, tone: "bad" };
  if (!safe) return { text: `${Math.round(-outOfArena)} m inside the arena edge`, tone: "ok" };
  const outOfSafe = signedDistanceToEdgeM(pos, safe);
  if (outOfSafe > 0) return { text: `Outside the safe zone by ${Math.round(outOfSafe)} m`, tone: "bad" };
  const inside = Math.round(-outOfSafe);
  return { text: `Inside the safe zone, ${inside} m from the edge`, tone: inside < 10 ? "warn" : "ok" };
}
