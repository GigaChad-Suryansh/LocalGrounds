import { describe, it, expect } from "vitest";
import {
  haversineM,
  bearingDeg,
  destinationPoint,
  isValidLatLng,
  isInsideCircle,
  signedDistanceToEdgeM,
  classifyContainment,
  safeZoneForPhase,
  classifyRegion,
  validatePhases,
  zoomForRadius,
  DEFAULT_PHASES,
  checkSample,
  isFresh,
  isSuspiciousJump,
  DEFAULT_FRESHNESS,
} from "../src/geo";
import type { Circle, LocationSample } from "../src/shared/types";

const CENTER = { lat: 28.6139, lng: 77.209 }; // New Delhi
const ARENA: Circle = { center: CENTER, radiusM: 150 };
const NOW = 1_700_000_000_000;

const sample = (
  p: { lat: number; lng: number },
  over: Partial<LocationSample> = {},
): LocationSample => ({
  ...p,
  accuracyM: 5,
  timestampMs: NOW,
  ...over,
});

describe("geographic distance", () => {
  it("is zero for identical points", () => {
    expect(haversineM(CENTER, CENTER)).toBe(0);
  });

  it("matches the known London–Paris distance (~343.5 km)", () => {
    const london = { lat: 51.5074, lng: -0.1278 };
    const paris = { lat: 48.8566, lng: 2.3522 };
    const d = haversineM(london, paris);
    expect(d).toBeGreaterThan(342_000);
    expect(d).toBeLessThan(345_000);
  });

  it("is symmetric", () => {
    const b = { lat: 28.62, lng: 77.22 };
    expect(haversineM(CENTER, b)).toBeCloseTo(haversineM(b, CENTER), 6);
  });

  it("one degree of latitude is about 111.2 km", () => {
    const d = haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  it("round-trips with destinationPoint", () => {
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const dest = destinationPoint(CENTER, bearing, 100);
      expect(haversineM(CENTER, dest)).toBeCloseTo(100, 3);
    }
  });

  it("computes cardinal bearings", () => {
    // Compare on the circle so 359.9999° and 0° count as equal.
    const angularDiff = (a: number, b: number) =>
      Math.abs(((a - b + 540) % 360) - 180);
    for (const b of [0, 90, 180, 270]) {
      const measured = bearingDeg(CENTER, destinationPoint(CENTER, b, 100));
      expect(180 - angularDiff(measured, b)).toBeCloseTo(180, 3);
    }
  });

  it("validates coordinates", () => {
    expect(isValidLatLng(CENTER)).toBe(true);
    expect(isValidLatLng({ lat: 91, lng: 0 })).toBe(false);
    expect(isValidLatLng({ lat: 0, lng: 181 })).toBe(false);
    expect(isValidLatLng({ lat: NaN, lng: 0 })).toBe(false);
  });
});

describe("circular boundary checks", () => {
  it("centre is inside", () => {
    expect(isInsideCircle(CENTER, ARENA)).toBe(true);
  });

  it("points just inside / just outside the edge", () => {
    expect(isInsideCircle(destinationPoint(CENTER, 30, 149), ARENA)).toBe(true);
    expect(isInsideCircle(destinationPoint(CENTER, 30, 151), ARENA)).toBe(false);
  });

  it("signed distance is negative inside, positive outside", () => {
    expect(signedDistanceToEdgeM(destinationPoint(CENTER, 0, 100), ARENA)).toBeCloseTo(-50, 3);
    expect(signedDistanceToEdgeM(destinationPoint(CENTER, 0, 200), ARENA)).toBeCloseTo(50, 3);
  });

  it("classifies with GPS accuracy: inside, outside, uncertain", () => {
    const deepInside = sample(destinationPoint(CENTER, 0, 50), { accuracyM: 10 });
    const farOutside = sample(destinationPoint(CENTER, 0, 250), { accuracyM: 10 });
    const nearEdge = sample(destinationPoint(CENTER, 0, 148), { accuracyM: 10 });
    expect(classifyContainment(deepInside, ARENA)).toBe("inside");
    expect(classifyContainment(farOutside, ARENA)).toBe("outside");
    expect(classifyContainment(nearEdge, ARENA)).toBe("uncertain");
  });
});

describe("dynamic safe-zone calculation", () => {
  it("default phases are valid", () => {
    expect(validatePhases(DEFAULT_PHASES)).toEqual([]);
  });

  it("rejects growing zones, bad fractions and empty configs", () => {
    expect(validatePhases([])).not.toEqual([]);
    expect(
      validatePhases([
        { radiusFraction: 0.5, holdSeconds: 10, warningSeconds: 0 },
        { radiusFraction: 0.8, holdSeconds: 10, warningSeconds: 0 },
      ]),
    ).not.toEqual([]);
    expect(
      validatePhases([{ radiusFraction: 1.5, holdSeconds: 10, warningSeconds: 0 }]),
    ).not.toEqual([]);
    expect(
      validatePhases([{ radiusFraction: 0.5, holdSeconds: 0, warningSeconds: 0 }]),
    ).not.toEqual([]);
  });

  it("shrinks by configured fractions and keeps the centre", () => {
    expect(safeZoneForPhase(ARENA, DEFAULT_PHASES, 0).radiusM).toBe(150);
    expect(safeZoneForPhase(ARENA, DEFAULT_PHASES, 1).radiusM).toBeCloseTo(112.5, 6);
    expect(safeZoneForPhase(ARENA, DEFAULT_PHASES, 2).radiusM).toBeCloseTo(75, 6);
    expect(safeZoneForPhase(ARENA, DEFAULT_PHASES, 3).radiusM).toBeCloseTo(37.5, 6);
    expect(safeZoneForPhase(ARENA, DEFAULT_PHASES, 2).center).toEqual(CENTER);
  });

  it("clamps out-of-range phase indexes and never mutates the outer boundary", () => {
    const last = DEFAULT_PHASES[DEFAULT_PHASES.length - 1]!;
    expect(safeZoneForPhase(ARENA, DEFAULT_PHASES, 99).radiusM).toBeCloseTo(
      150 * last.radiusFraction,
      6,
    );
    expect(safeZoneForPhase(ARENA, DEFAULT_PHASES, -3).radiusM).toBe(150);
    expect(ARENA.radiusM).toBe(150);
  });

  it("picks a sensible zoom: bigger arenas zoom out", () => {
    const z30 = zoomForRadius(30, CENTER.lat);
    const z300 = zoomForRadius(300, CENTER.lat);
    expect(z30).toBeGreaterThan(z300);
    expect(z30).toBeLessThanOrEqual(20);
    expect(z300).toBeGreaterThanOrEqual(1);
  });
});

describe("red-zone detection", () => {
  const safe = safeZoneForPhase(ARENA, DEFAULT_PHASES, 2); // 75 m

  it("safe inside the safe circle", () => {
    expect(classifyRegion(destinationPoint(CENTER, 10, 40), ARENA, safe)).toBe("safe");
  });

  it("red between safe circle and outer boundary", () => {
    expect(classifyRegion(destinationPoint(CENTER, 10, 100), ARENA, safe)).toBe("red");
  });

  it("outOfBounds beyond the outer boundary", () => {
    expect(classifyRegion(destinationPoint(CENTER, 10, 200), ARENA, safe)).toBe("outOfBounds");
  });
});

describe("GPS freshness validation", () => {
  it("accepts a fresh, accurate sample", () => {
    expect(checkSample(sample(CENTER), NOW + 2_000).ok).toBe(true);
    expect(isFresh(sample(CENTER), NOW + 2_000)).toBe(true);
  });

  it("flags stale samples", () => {
    const r = checkSample(sample(CENTER), NOW + DEFAULT_FRESHNESS.maxAgeMs + 1);
    expect(r.ok).toBe(false);
    expect(r.issues).toContain("stale");
  });

  it("flags poor accuracy", () => {
    const r = checkSample(sample(CENTER, { accuracyM: 80 }), NOW);
    expect(r.issues).toContain("inaccurate");
  });

  it("flags timestamps from the future", () => {
    const r = checkSample(sample(CENTER, { timestampMs: NOW + 60_000 }), NOW);
    expect(r.issues).toContain("from_future");
  });

  it("flags invalid coordinates and accuracy", () => {
    expect(checkSample(sample({ lat: 200, lng: 0 }), NOW).issues).toContain("invalid_coordinates");
    expect(checkSample(sample(CENTER, { accuracyM: -1 }), NOW).issues).toContain("invalid_accuracy");
    expect(checkSample(sample(CENTER, { accuracyM: NaN }), NOW).issues).toContain("invalid_accuracy");
  });

  it("treats undefined as not fresh", () => {
    expect(isFresh(undefined, NOW)).toBe(false);
  });

  it("detects teleport jumps but tolerates GPS noise and running", () => {
    const a = sample(CENTER, { timestampMs: NOW });
    const walk = sample(destinationPoint(CENTER, 0, 10), { timestampMs: NOW + 5_000 });
    const noise = sample(destinationPoint(CENTER, 0, 8), { timestampMs: NOW + 1_000, accuracyM: 8 });
    const teleport = sample(destinationPoint(CENTER, 0, 500), { timestampMs: NOW + 2_000 });
    expect(isSuspiciousJump(a, walk)).toBe(false);
    expect(isSuspiciousJump(a, noise)).toBe(false);
    expect(isSuspiciousJump(a, teleport)).toBe(true);
  });

  it("treats non-increasing timestamps as suspicious", () => {
    const a = sample(CENTER, { timestampMs: NOW });
    expect(isSuspiciousJump(a, sample(CENTER, { timestampMs: NOW }))).toBe(true);
    expect(isSuspiciousJump(a, sample(CENTER, { timestampMs: NOW - 1_000 }))).toBe(true);
  });
});
