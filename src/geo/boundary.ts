import type { Circle, LatLng, LocationSample } from "../shared/types";
import { haversineM } from "./distance";

export function distanceToCenterM(point: LatLng, circle: Circle): number {
  return haversineM(point, circle.center);
}

/** True when the point lies inside or exactly on the circle. */
export function isInsideCircle(point: LatLng, circle: Circle): boolean {
  return distanceToCenterM(point, circle) <= circle.radiusM;
}

/**
 * Signed distance to the circle edge in metres.
 * Negative = inside (magnitude is distance to edge), positive = outside.
 */
export function signedDistanceToEdgeM(point: LatLng, circle: Circle): number {
  return distanceToCenterM(point, circle) - circle.radiusM;
}

export type Containment = "inside" | "outside" | "uncertain";

/**
 * Accuracy-aware containment. A sample is only "inside"/"outside" when its
 * whole accuracy circle is on one side of the edge; otherwise "uncertain".
 * Callers should treat "uncertain" as benign (never eliminate on it).
 */
export function classifyContainment(
  sample: LocationSample,
  circle: Circle,
): Containment {
  const signed = signedDistanceToEdgeM(sample, circle);
  const acc = Math.max(0, sample.accuracyM);
  if (signed + acc <= 0) return "inside";
  if (signed - acc > 0) return "outside";
  return "uncertain";
}
