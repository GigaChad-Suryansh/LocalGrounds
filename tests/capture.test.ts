import { describe, it, expect } from "vitest";
import {
  createPlayer,
  validateProximity,
  DEFAULT_CAPTURE,
  type PlayerState,
  type Role,
} from "../src/engine";
import type { LatLng } from "../src/shared/types";
import { CENTER, NOW, SEC, at } from "./helpers";

const NOW_CHECK = NOW + 1 * SEC;

function pl(
  id: string,
  role: Role,
  pos: LatLng | null,
  o: { acc?: number; tsMs?: number; suspicious?: boolean; status?: PlayerState["status"] } = {},
): PlayerState {
  const p = createPlayer(id, id, role);
  return {
    ...p,
    status: o.status ?? "active",
    suspicious: o.suspicious ?? false,
    sample: pos
      ? { lat: pos.lat, lng: pos.lng, accuracyM: o.acc ?? 5, timestampMs: o.tsMs ?? NOW }
      : null,
  };
}

const killer = (o = {}) => pl("k", "killer", CENTER, o);
const survivorAt = (d: number, o = {}) => pl("s", "survivor", at(0, d), o);

describe("capture radius validation", () => {
  it("captures inside the radius", () => {
    const r = validateProximity(killer(), survivorAt(10), NOW_CHECK);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.distanceM).toBeCloseTo(10, 2);
  });

  it("rejects out of range", () => {
    const r = validateProximity(killer(), survivorAt(40), NOW_CHECK);
    expect(r).toEqual({ ok: false, reason: "out_of_range" });
  });

  it("forgives GPS uncertainty, but only up to the cap", () => {
    // 30 m apart, 8+8 m accuracy -> forgives 10 (cap) -> 20 m <= 25
    expect(validateProximity(killer({ acc: 8 }), survivorAt(30, { acc: 8 }), NOW_CHECK).ok).toBe(true);
    // 30 m apart, 1+1 m accuracy -> forgives 2 -> 28 m > 25
    expect(validateProximity(killer({ acc: 1 }), survivorAt(30, { acc: 1 }), NOW_CHECK).ok).toBe(false);
    // bad accuracy can't be farmed: 50 m, 25+25 m accuracy -> still only 10 forgiven
    expect(validateProximity(killer({ acc: 25 }), survivorAt(50, { acc: 25 }), NOW_CHECK).ok).toBe(false);
  });

  it("respects a configured capture radius", () => {
    const cfg = { ...DEFAULT_CAPTURE, captureRadiusM: 10 };
    expect(validateProximity(killer({ acc: 1 }), survivorAt(15, { acc: 1 }), NOW_CHECK, cfg).ok).toBe(false);
    expect(validateProximity(killer({ acc: 1 }), survivorAt(15, { acc: 1 }), NOW_CHECK).ok).toBe(true);
  });
});

describe("capture authorization and state", () => {
  it("only killers can capture, only survivors can be captured", () => {
    const s = survivorAt(5);
    expect(validateProximity(pl("x", "survivor", CENTER), s, NOW_CHECK)).toMatchObject({
      reason: "not_a_killer",
    });
    expect(validateProximity(killer(), pl("y", "killer", at(0, 5)), NOW_CHECK)).toMatchObject({
      reason: "not_a_survivor",
    });
  });

  it("rejects self-capture and inactive players", () => {
    const k = killer();
    expect(validateProximity(k, { ...k, role: "survivor" } as PlayerState, NOW_CHECK)).toMatchObject({
      reason: "same_player",
    });
    expect(validateProximity(killer({ status: "eliminated" }), survivorAt(5), NOW_CHECK)).toMatchObject({
      reason: "killer_inactive",
    });
    expect(validateProximity(killer(), survivorAt(5, { status: "captured" }), NOW_CHECK)).toMatchObject({
      reason: "survivor_inactive",
    });
  });
});

describe("capture requires reliable, fresh, consistent locations", () => {
  it("rejects missing locations and says which side", () => {
    expect(validateProximity(killer(), pl("s", "survivor", null), NOW_CHECK)).toEqual({
      ok: false,
      reason: "no_location",
      side: "survivor",
    });
  });

  it("rejects stale locations", () => {
    const old = NOW - 20 * SEC;
    expect(validateProximity(killer({ tsMs: old }), survivorAt(5), NOW_CHECK)).toEqual({
      ok: false,
      reason: "stale_location",
      side: "killer",
    });
    expect(validateProximity(killer(), survivorAt(5, { tsMs: old }), NOW_CHECK)).toEqual({
      ok: false,
      reason: "stale_location",
      side: "survivor",
    });
  });

  it("rejects inaccurate locations", () => {
    expect(validateProximity(killer(), survivorAt(5, { acc: 40 }), NOW_CHECK)).toEqual({
      ok: false,
      reason: "inaccurate_location",
      side: "survivor",
    });
  });

  it("rejects samples taken too far apart in time", () => {
    const r = validateProximity(
      killer({ tsMs: NOW }),
      survivorAt(5, { tsMs: NOW + 13 * SEC }),
      NOW + 14 * SEC,
    );
    expect(r).toEqual({ ok: false, reason: "sample_skew" });
  });

  it("rejects suspicious (teleporting) locations", () => {
    expect(validateProximity(killer(), survivorAt(5, { suspicious: true }), NOW_CHECK)).toEqual({
      ok: false,
      reason: "suspicious_location",
      side: "survivor",
    });
  });
});
