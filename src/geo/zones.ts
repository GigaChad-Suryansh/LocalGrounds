import type { Circle, LatLng } from "../shared/types";
import { haversineM } from "./distance";

/** Host-selectable arena radii in metres. */
export const RADIUS_PRESETS_M = [30, 75, 150, 300] as const;

export interface ZonePhaseConfig {
  /** Safe-zone radius as a fraction of the initial radius (0 < f <= 1). */
  radiusFraction: number;
  /** Seconds the phase holds before the zone starts shrinking to the next one. */
  holdSeconds: number;
  /** Seconds of countdown/warning shown before this phase's zone takes effect. */
  warningSeconds: number;
}

export const DEFAULT_PHASES: readonly ZonePhaseConfig[] = [
  { radiusFraction: 1.0, holdSeconds: 180, warningSeconds: 0 },
  { radiusFraction: 0.75, holdSeconds: 150, warningSeconds: 30 },
  { radiusFraction: 0.5, holdSeconds: 120, warningSeconds: 30 },
  { radiusFraction: 0.25, holdSeconds: 90, warningSeconds: 30 },
  { radiusFraction: 0.1, holdSeconds: 60, warningSeconds: 30 },
];

export type ZoneRegion = "safe" | "red" | "outOfBounds";

export function validatePhases(phases: readonly ZonePhaseConfig[]): string[] {
  const errors: string[] = [];
  if (phases.length === 0) errors.push("At least one phase is required.");
  let prev = Infinity;
  phases.forEach((p, i) => {
    if (!(p.radiusFraction > 0 && p.radiusFraction <= 1))
      errors.push(`Phase ${i + 1}: radiusFraction must be in (0, 1].`);
    if (p.radiusFraction > prev)
      errors.push(`Phase ${i + 1}: safe zone may not grow.`);
    if (!(p.holdSeconds > 0))
      errors.push(`Phase ${i + 1}: holdSeconds must be > 0.`);
    if (p.warningSeconds < 0)
      errors.push(`Phase ${i + 1}: warningSeconds must be >= 0.`);
    const before = phases[i - 1];
    if (before && p.warningSeconds > before.holdSeconds)
      errors.push(
        `Phase ${i + 1}: warning window cannot be longer than the previous phase's hold.`,
      );
    prev = p.radiusFraction;
  });
  return errors;
}

/**
 * Safe-zone circle for a given phase index (clamped to the last phase).
 * The zone stays centred on the arena centre; the outer boundary is never changed here.
 */
export function safeZoneForPhase(
  outer: Circle,
  phases: readonly ZonePhaseConfig[],
  phaseIndex: number,
): Circle {
  const idx = Math.min(Math.max(0, phaseIndex), phases.length - 1);
  const phase = phases[idx];
  if (!phase) throw new Error("No phases configured");
  return { center: outer.center, radiusM: outer.radiusM * phase.radiusFraction };
}

/** Classify a position against the fixed outer boundary and the current safe zone. */
export function classifyRegion(
  point: LatLng,
  outer: Circle,
  safe: Circle,
): ZoneRegion {
  if (haversineM(point, outer.center) > outer.radiusM) return "outOfBounds";
  if (haversineM(point, safe.center) > safe.radiusM) return "red";
  return "safe";
}

/** Map zoom level that comfortably fits a circle of the given radius on a ~360px wide map. */
export function zoomForRadius(radiusM: number, latitude: number): number {
  const widthPx = 360;
  const metersPerPixelAtZoom0 = 156_543.03392 * Math.cos((latitude * Math.PI) / 180);
  const targetMetersPerPixel = (radiusM * 2.4) / widthPx; // 20% padding each side
  const zoom = Math.log2(metersPerPixelAtZoom0 / targetMetersPerPixel);
  return Math.min(20, Math.max(1, Math.floor(zoom)));
}
