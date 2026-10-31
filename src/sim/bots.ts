import { bearingDeg, destinationPoint, haversineM } from "../geo/distance";
import type { LatLng } from "../shared/types";
import type { Behavior, BotCtx, SimBot } from "./types";

const dist = haversineM;
const nearest = (from: LatLng, bots: readonly SimBot[]): SimBot | null =>
  bots.reduce<SimBot | null>((b, o) => (!b || dist(from, o.truth) < dist(from, b.truth) ? o : b), null);

/** A point `m` metres from `p` heading away from `from`. */
const awayFrom = (p: LatLng, from: LatLng, m: number): LatLng =>
  destinationPoint(p, (bearingDeg(from, p) + 360) % 360, m);

/** Keep within the visible safe zone: head back toward the centre once near its edge. */
function inward(ctx: BotCtx, want: LatLng | null): LatLng | null {
  const edge = ctx.safeRadiusM * 0.7;
  if (dist(ctx.center, ctx.bot.truth) > edge) return ctx.center;
  if (want && dist(ctx.center, want) > edge) return ctx.center;
  return want;
}

/** Stands still inside the safe zone (a survivor hiding in a bush). */
export const hide: Behavior = (ctx) => ({ to: inward(ctx, null) });

/** Wanders slowly inside the safe zone. */
export const wander: Behavior = (ctx) => {
  const step = destinationPoint(ctx.bot.truth, ctx.rng.range(0, 360), 8);
  return { to: inward(ctx, step) };
};

/** Runs from the nearest killer when they get close, otherwise stays put, always inside the zone. */
export const flee: Behavior = (ctx) => {
  const killer = nearest(ctx.bot.truth, ctx.bots.filter((b) => b.spec.role === "killer"));
  if (killer && dist(ctx.bot.truth, killer.truth) < 45)
    return { to: inward(ctx, awayFrom(ctx.bot.truth, killer.truth, 30)) };
  return { to: inward(ctx, null) };
};

/** Walks straight out of the arena and keeps going: deliberately breaks the rules. */
export const leaveArena: Behavior = (ctx) => ({
  to: awayFrom(ctx.bot.truth, ctx.center, 40),
});

/**
 * Killer: heads for where it last saw a survivor (scan reveals) and closes in on anyone it can
 * actually see (within 20 m, like line of sight); the Radar Lock does the rest. Never uses hidden positions.
 */
export const hunt: Behavior = (ctx) => {
  const snap = ctx.snapshot;
  if (snap)
    for (const o of snap.others)
      if (o.role === "survivor" && o.position) ctx.bot.seen[o.id] = { lat: o.position.lat, lng: o.position.lng };
  const alive = new Set(snap?.others.filter((o) => o.role === "survivor" && o.status === "active").map((o) => o.id));
  const lastSeen = Object.entries(ctx.bot.seen)
    .filter(([id]) => alive.has(id))
    .map(([, p]) => p)
    .sort((a, b) => dist(ctx.bot.truth, a) - dist(ctx.bot.truth, b))[0];

  const inSight = ctx.bots
    .filter((b) => b.spec.role === "survivor" && alive.has(b.playerId) && dist(ctx.bot.truth, b.truth) <= 20)
    .map((b) => b.playerId);
  const target = lastSeen ?? ctx.center;
  const patrol = dist(ctx.bot.truth, target) < 10 ? destinationPoint(target, ctx.rng.range(0, 360), 30) : target;
  const sighted = ctx.bots.find((b) => inSight.includes(b.playerId));
  return { to: inward(ctx, sighted ? sighted.truth : patrol) };
};
