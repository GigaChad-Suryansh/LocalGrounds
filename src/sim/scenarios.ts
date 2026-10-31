import type { ZonePhaseConfig } from "../geo/zones";
import { flee, hide, hunt, leaveArena, wander } from "./bots";
import type { Scenario } from "./run";
import type { BotSpec } from "./types";

/** Faster than the real defaults so a whole match fits in a few simulated minutes. */
const PHASES: ZonePhaseConfig[] = [
  { radiusFraction: 1, holdSeconds: 60, warningSeconds: 0 },
  { radiusFraction: 0.5, holdSeconds: 60, warningSeconds: 15 },
  { radiusFraction: 0.25, holdSeconds: 90, warningSeconds: 15 },
];
const SERVICE = {
  gameConfig: {
    reveal: { intervalMs: 30_000, durationMs: 10_000 },
    redZone: { graceSeconds: 8, confirmSamples: 2, penalty: { kind: "eliminate" as const }, maxStepMs: 10_000 },
  },
};

const killer = (name = "Kai", start = { bearing: 0, distanceM: 0 }, behavior = hunt): BotSpec => ({
  name, role: "killer", start, speedMps: 2.5, behavior,
});
/** A killer who never goes after anyone, so the match stays open for the scripted events. */
const idleKiller = (name = "Kai", start = { bearing: 0, distanceM: 0 }) => killer(name, start, hide);
const survivor = (name: string, bearing: number, distanceM: number, behavior = hide, gps: BotSpec["gps"] = {}): BotSpec => ({
  name, role: "survivor", start: { bearing, distanceM }, speedMps: 1.8, behavior, gps,
});

const base = { radiusM: 150, phases: PHASES, service: SERVICE, maxSec: 600 };

const name = (r: { eliminated: string[] }) => r.eliminated.join(", ") || "nobody";

export const SCENARIOS: Scenario[] = [
  {
    ...base,
    name: "hide-and-seek",
    description: "1 killer hunts 4 survivors who flee or hide. Everything the game promises must hold.",
    bots: [killer(), survivor("Sam", 180, 60, flee), survivor("Cam", 90, 80, wander), survivor("Dee", 270, 50, flee), survivor("Eli", 30, 40, hide)],
    expect: (r) => (r.stats.reveals === 0 ? ["no scan ever happened"] : []),
  },
  {
    ...base,
    name: "campers-stay-safe",
    description: "Survivors stay inside the safe zone the whole match. Nobody may be eliminated.",
    bots: [killer(), survivor("Sam", 180, 40), survivor("Cam", 90, 30), survivor("Dee", 270, 20)],
    expect: (r) => (r.eliminated.length > 0 ? [`eliminated ${name(r)} while inside the safe zone`] : []),
  },
  {
    ...base,
    name: "rule-breakers-are-eliminated",
    description: "Two survivors walk out of the arena; the one who hides stays in.",
    bots: [killer(), survivor("Out1", 90, 60, leaveArena), survivor("Out2", 270, 60, leaveArena), survivor("Stay", 180, 20)],
    expect: (r) => {
      const f: string[] = [];
      for (const n of ["Out1", "Out2"]) if (!r.eliminated.includes(n)) f.push(`${n} left the arena but was never eliminated`);
      if (r.eliminated.includes("Stay")) f.push("the survivor who stayed inside was eliminated");
      return f;
    },
  },
  {
    ...base,
    name: "gps-chaos",
    description: "Dropouts, stale fixes and urban-canyon bursts of 60 m accuracy. Bad GPS must never eliminate anyone.",
    bots: [
      killer(),
      survivor("Sam", 180, 30, hide, { dropout: 0.3, staleChance: 0.2, burst: { everyS: 40, lengthS: 15, accuracyM: 60, sigmaM: 25 } }),
      survivor("Cam", 90, 25, wander, { sigmaM: 8, accuracyM: 20, dropout: 0.15 }),
    ],
    expect: (r) => (r.eliminated.length > 0 ? [`eliminated ${name(r)} because of poor GPS`] : []),
  },
  {
    ...base,
    name: "gps-spoofer",
    description: "A survivor's phone reports a spot 800 m away for 20 s. They are still inside, so they must not be eliminated.",
    bots: [killer(), survivor("Spoof", 180, 25, hide, { spoof: { atS: 100, forS: 20, jumpM: 800 } }), survivor("Sam", 90, 25)],
    expect: (r) => (r.eliminated.includes("Spoof") ? ["a spoofed jump got an inside player eliminated"] : []),
  },
  {
    ...base,
    name: "dropped-connections",
    description: "Phones lose signal and resume with their token; the match carries on and nobody is lost.",
    timeoutOk: true,
    bots: [idleKiller(), survivor("Sam", 180, 30), survivor("Cam", 90, 25)],
    script: [
      { atSec: 80, run: (w) => { w.disconnect(w.bots[1]!); w.disconnect(w.bots[2]!); } },
      { atSec: 110, run: (w) => { w.reconnect(w.bots[1]!); w.reconnect(w.bots[2]!); } },
    ],
    expect: (r, w) => {
      const f: string[] = [];
      for (const b of w.bots.slice(1)) if (b.snapshot?.self.id !== b.playerId) f.push(`${b.spec.name} did not resume`);
      if (r.eliminated.length > 0) f.push(`${name(r)} was eliminated by a dropped connection`);
      return f;
    },
  },
  {
    ...base,
    name: "emergency-pause",
    description: "A survivor pauses at 90 s. A non-host can't resume; the host does. The match is frozen in between.",
    timeoutOk: true,
    bots: [idleKiller(), survivor("Sam", 180, 30), survivor("Cam", 90, 25)],
    script: [
      { atSec: 90, run: (w) => w.send(w.bots[1]!, { t: "pause" }) },
      { atSec: 100, run: (w) => w.send(w.bots[1]!, { t: "resume_match" }) },
      { atSec: 140, run: (w) => w.send(w.host(), { t: "resume_match" }) },
    ],
    expect: (r, w) => {
      const f: string[] = [];
      if (!r.errors.some((e) => e.bot === "Sam" && e.tSec >= 99 && e.tSec <= 100)) f.push("a survivor was allowed to resume a paused match");
      if (w.host().snapshot?.matchPhase === "paused") f.push("the host could not resume");
      return f;
    },
  },
  {
    ...base,
    name: "host-leaves",
    description: "The host (a killer) walks away mid-match. The room must stay consistent and never end up with no host.",
    timeoutOk: true,
    bots: [idleKiller(), idleKiller("Kit", { bearing: 45, distanceM: 20 }), survivor("Sam", 180, 30), survivor("Cam", 90, 25)],
    script: [{ atSec: 120, run: (w) => w.send(w.host(), { t: "leave" }) }],
    expect: (r, w) => {
      const f: string[] = [];
      if (r.hostId === w.host().playerId) f.push("the host who left is still the host");
      if (!r.hostId) f.push("the room has no host");
      return f;
    },
  },
];
