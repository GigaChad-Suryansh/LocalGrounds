import { describe, expect, it } from "vitest";
import { hide, hunt, Monitor, runScenario, SCENARIOS, SimWorld, SIM_CENTER } from "../src/sim";
import { Rng } from "../src/sim/rng";
import type { ServerMessage } from "../src/server";

describe("simulated matches", () => {
  for (const sc of SCENARIOS) {
    it(`${sc.name}: ${sc.description}`, () => {
      for (const seed of [1, 2, 3]) {
        const r = runScenario(sc, seed);
        expect(r.failures, `seed ${seed}`).toEqual([]);
      }
    });
  }

  it("is reproducible: the same seed gives the same match", () => {
    const sc = SCENARIOS[0]!;
    const a = runScenario(sc, 7);
    const b = runScenario(sc, 7);
    expect(a.endedAtSec).toBe(b.endedAtSec);
    expect(a.captured).toEqual(b.captured);
    expect(a.stats).toEqual(b.stats);
  });
});

describe("the monitor really catches broken rules", () => {
  function setup() {
    const world = new SimWorld({
      seed: 1, center: SIM_CENTER, radiusM: 150,
      phases: [{ radiusFraction: 1, holdSeconds: 600, warningSeconds: 0 }],
      bots: [
        { name: "Kai", role: "killer", start: { bearing: 0, distanceM: 0 }, speedMps: 2, behavior: hunt },
        { name: "Sam", role: "survivor", start: { bearing: 180, distanceM: 80 }, speedMps: 2, behavior: hide },
      ],
    });
    const monitor = new Monitor(world);
    world.onMessage = (b, m) => monitor.onMessage(b, m);
    world.setup();
    world.step(() => ({ to: null }));
    return { world, monitor, kai: world.bots[0]!, sam: world.bots[1]! };
  }

  it("flags a survivor's position shown to the killer outside a scan", () => {
    const { world, monitor, kai, sam } = setup();
    const snap = structuredClone(kai.snapshot!);
    snap.reveal = null;
    snap.others = [{ id: sam.playerId, name: "Sam", role: "survivor", status: "active", ready: true,
      position: { lat: sam.truth.lat, lng: sam.truth.lng, accuracyM: 5, ageMs: 0 }, signalLost: false }];
    const msg: ServerMessage = { t: "snapshot", snapshot: snap, room: monitor.room! };
    monitor.onMessage(kai, msg);
    expect(monitor.violations.map((v) => v.rule)).toContain("leak");
    expect(world.tSec).toBeGreaterThan(0);
  });

  it("flags coordinates inside an events message", () => {
    const { monitor, kai } = setup();
    monitor.onMessage(kai, { t: "events", events: [{ seq: 99, atMs: 0, audience: "all", type: "match_started", lat: 1 } as never] });
    expect(monitor.violations.map((v) => v.rule)).toContain("leak");
  });

  it("flags a capture between players who were never close", () => {
    const { monitor, kai, sam } = setup();
    monitor.onMessage(kai, { t: "events", events: [{ seq: 100, atMs: 0, audience: "all", type: "captured", killerId: kai.playerId, survivorId: sam.playerId }] });
    expect(monitor.violations.map((v) => v.rule)).toContain("capture");
  });

  it("flags an elimination right after the player was comfortably inside the safe zone", () => {
    const { world, monitor, kai, sam } = setup();
    monitor.afterStep();
    monitor.onMessage(kai, { t: "events", events: [{ seq: 101, atMs: 0, audience: "all", type: "eliminated", playerId: sam.playerId, cause: "red_zone" }] });
    expect(monitor.violations.map((v) => v.rule)).toContain("false_elimination");
    expect(world.tSec).toBe(1);
  });
});

describe("rng", () => {
  it("is deterministic and roughly normal", () => {
    const a = new Rng(5), b = new Rng(5);
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
    const r = new Rng(9);
    const xs = Array.from({ length: 4000 }, () => r.gauss(3));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.2);
    expect(sd).toBeGreaterThan(2.7);
    expect(sd).toBeLessThan(3.3);
  });
});
