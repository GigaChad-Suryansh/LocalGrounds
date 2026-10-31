import type { ZonePhaseConfig } from "../geo/zones";
import type { ServiceOptions } from "../server";
import type { LatLng } from "../shared/types";
import { Monitor, type SimStats, type Violation } from "./monitor";
import type { BotSpec } from "./types";
import { SimWorld } from "./world";

export interface Scenario {
  name: string;
  description: string;
  radiusM: number;
  phases: readonly ZonePhaseConfig[];
  service?: ServiceOptions;
  bots: readonly BotSpec[];
  maxSec: number;
  /** True when the scenario deliberately keeps the match open, so not finishing is fine. */
  timeoutOk?: boolean;
  /** Things that happen to the world at a given second (drop a connection, press pause...). */
  script?: ReadonlyArray<{ atSec: number; run: (w: SimWorld, m: Monitor) => void }>;
  /** Extra expectations on top of the always-on invariants. Return a message per failure. */
  expect?: (r: SimResult, w: SimWorld) => string[];
}

export interface SimResult {
  scenario: string;
  seed: number;
  endedAtSec: number;
  endReason: string | null;
  stats: SimStats;
  violations: Violation[];
  /** Expectation failures, plus violations rendered as text. Empty = pass. */
  failures: string[];
  eliminated: string[];
  captured: string[];
  errors: Array<{ bot: string; code: string; message: string; tSec: number }>;
  hostId: string | null;
}

export const SIM_CENTER: LatLng = { lat: 28.6139, lng: 77.209 };

export function runScenario(s: Scenario, seed = 1): SimResult {
  const world = new SimWorld({
    seed, center: SIM_CENTER, radiusM: s.radiusM, phases: s.phases, service: s.service, bots: s.bots,
  });
  const monitor = new Monitor(world);
  world.onMessage = (bot, msg) => monitor.onMessage(bot, msg);
  world.setup();

  let endedAt = -1;
  for (let i = 0; i < s.maxSec; i++) {
    for (const a of s.script ?? []) if (a.atSec === world.tSec + 1) a.run(world, monitor);
    world.step((bot) => {
      const snapshot = bot.snapshot;
      const safeRadiusM = snapshot?.zone?.safeZone.radiusM ?? snapshot?.outer.radiusM ?? s.radiusM;
      return bot.spec.behavior({ bot, bots: world.bots, snapshot, tSec: world.tSec, rng: world.rng, safeRadiusM, center: SIM_CENTER });
    });
    monitor.afterStep();
    if (world.host().snapshot?.matchPhase === "ended" && endedAt < 0) endedAt = world.tSec;
    if (endedAt >= 0 && world.tSec >= endedAt + 3) break; // run a few seconds past the end to check nothing leaks
  }

  const result: SimResult = {
    scenario: s.name,
    seed,
    endedAtSec: endedAt,
    endReason: monitor.endReason,
    stats: monitor.stats,
    violations: monitor.violations,
    failures: monitor.violations.map((v) => `[${v.tSec}s] ${v.rule}: ${v.detail}`),
    eliminated: [...monitor.eliminated].map((id) => world.bots.find((b) => b.playerId === id)?.spec.name ?? id),
    captured: [...monitor.captured].map((id) => world.bots.find((b) => b.playerId === id)?.spec.name ?? id),
    errors: world.errors,
    hostId: monitor.room?.hostId ?? null,
  };
  if (endedAt < 0 && !s.timeoutOk) result.failures.push(`the match did not finish within ${s.maxSec} s`);
  result.failures.push(...(s.expect?.(result, world) ?? []));
  return result;
}
