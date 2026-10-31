import { destinationPoint } from "../../../src/geo/distance";
import type { Circle } from "../../../src/shared/types";

export type Ring = Array<[lat: number, lng: number]>;

/** Polygon approximation of a geographic circle, starting due north and going clockwise. */
export function circleRing(c: Circle, points = 96): Ring {
  const ring: Ring = [];
  for (let i = 0; i < points; i++) {
    const p = destinationPoint(c.center, (360 * i) / points, c.radiusM);
    ring.push([p.lat, p.lng]);
  }
  return ring;
}

/** A ring covering (almost) the whole map, used to dim everything outside the arena. */
export const WORLD_RING: Ring = [
  [-85, -179.99],
  [-85, 179.99],
  [85, 179.99],
  [85, -179.99],
];

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
