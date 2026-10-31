import type { GameEvent, Role } from "../../../src/engine";
import { matchOutcome, outcomeCopy } from "./outcome";

export type Tone = "info" | "warn" | "danger" | "good";

export type SoundName =
  | "start"
  | "warn"
  | "shrink"
  | "scan"
  | "caught"
  | "tag"
  | "alarm"
  | "clear"
  | "blip"
  | "win"
  | "lose";

/** One piece of game feedback: a banner, plus optional shake, flash, sound and vibration. */
export interface Fx {
  id: number;
  kind: string;
  title: string;
  subtitle?: string;
  tone: Tone;
  durationMs: number;
  shake?: boolean;
  flash?: boolean;
  sound?: SoundName;
  vibrate?: number[];
}
export type FxDraft = Omit<Fx, "id">;

export interface FxContext {
  myId: string;
  myRole: Role;
  names: Record<string, string>;
}

const nameOf = (ctx: FxContext, id: string): string => ctx.names[id] ?? "A player";

/** Turn a server event into feedback. Events never contain coordinates, so neither does this. */
export function fxForEvent(e: GameEvent, ctx: FxContext): FxDraft | null {
  switch (e.type) {
    case "match_started":
      return {
        kind: "match_start",
        title: "Match start",
        subtitle: ctx.myRole === "killer" ? "Find them before the zone closes." : "Stay hidden and stay inside.",
        tone: "good",
        durationMs: 2800,
        sound: "start",
        vibrate: [90],
      };
    case "match_paused":
      return {
        kind: "paused",
        title: "Paused",
        subtitle: `${e.byPlayerId === ctx.myId ? "You" : nameOf(ctx, e.byPlayerId)} paused the match.`,
        tone: "warn",
        durationMs: 3000,
        sound: "warn",
      };
    case "match_resumed":
      return { kind: "resumed", title: "Resumed", subtitle: "Back in play.", tone: "good", durationMs: 1800, sound: "clear" };
    case "match_ended": {
      const outcome = matchOutcome(e.reason, ctx.myRole);
      const copy = outcomeCopy(e.reason, outcome);
      return {
        kind: "match_end",
        title: copy.title,
        subtitle: copy.subtitle,
        tone: outcome === "victory" ? "good" : outcome === "defeat" ? "danger" : "info",
        durationMs: 3400,
        sound: outcome === "victory" ? "win" : outcome === "defeat" ? "lose" : "blip",
        vibrate: outcome === "draw" ? [60] : [120, 60, 120],
      };
    }
    case "zone_warning":
      return {
        kind: "zone_warning",
        title: "Zone closing",
        subtitle: "Move toward the centre.",
        tone: "warn",
        durationMs: 3200,
        sound: "warn",
        vibrate: [60, 40, 60],
      };
    case "zone_shrunk":
      return {
        kind: "zone_shrunk",
        title: "Zone closed",
        subtitle: "The safe area just got smaller.",
        tone: "warn",
        durationMs: 2600,
        shake: true,
        flash: true,
        sound: "shrink",
        vibrate: [140],
      };
    case "reveal_started":
      return {
        kind: "reveal_start",
        title: "Scan active",
        subtitle: `Everyone is visible for ${Math.round(e.durationMs / 1000)} seconds.`,
        tone: "warn",
        durationMs: 2800,
        sound: "scan",
        vibrate: [50, 30, 50],
      };
    case "reveal_ended":
      return {
        kind: "reveal_end",
        title: "Scan complete",
        subtitle: "Positions are hidden again.",
        tone: "info",
        durationMs: 1800,
        sound: "blip",
      };
    case "lock_started":
      return {
        kind: "lock_started",
        title: "Target detected",
        subtitle: `${nameOf(ctx, e.targetId)} is in range. Hold position.`,
        tone: "warn",
        durationMs: 1800,
        sound: "blip",
        vibrate: [50],
      };
    case "lock_lost":
      // "inactive" means the target is already out (the capture event says so); nothing to add.
      if (e.reason === "inactive") return null;
      return {
        kind: "lock_lost",
        title: "Target lost",
        subtitle: e.reason === "signal" ? "GPS signal dropped. Lock cancelled." : "They got out of range.",
        tone: "info",
        durationMs: 1800,
        sound: "blip",
        vibrate: [30],
      };
    case "radar_locked_on":
      return {
        kind: "radar_locked_on",
        title: "Radar lock detected",
        subtitle: "A killer is closing in. Get out of range!",
        tone: "danger",
        durationMs: 2400,
        flash: true,
        sound: "alarm",
        vibrate: [140, 60, 140],
      };
    case "radar_lock_cleared":
      return {
        kind: "radar_lock_cleared",
        title: "Lock broken",
        subtitle: "You slipped out of range.",
        tone: "good",
        durationMs: 1800,
        sound: "clear",
        vibrate: [40],
      };
    case "captured":
      if (e.survivorId === ctx.myId)
        return {
          kind: "caught",
          title: "Caught",
          subtitle: "A killer completed the radar lock.",
          tone: "danger",
          durationMs: 3400,
          shake: true,
          flash: true,
          sound: "caught",
          vibrate: [220, 80, 220],
        };
      if (e.killerId === ctx.myId)
        return {
          kind: "tagged",
          title: "Target captured",
          subtitle: `${nameOf(ctx, e.survivorId)} is out.`,
          tone: "good",
          durationMs: 2800,
          flash: true,
          sound: "tag",
          vibrate: [90, 40, 90],
        };
      return {
        kind: "capture_other",
        title: `${nameOf(ctx, e.survivorId)} caught`,
        subtitle: `Locked by ${nameOf(ctx, e.killerId)}.`,
        tone: "info",
        durationMs: 2400,
        sound: "blip",
      };
    case "eliminated":
      if (e.playerId === ctx.myId)
        return {
          kind: "eliminated",
          title: "Eliminated",
          subtitle: "You stayed outside the safe zone too long.",
          tone: "danger",
          durationMs: 3400,
          shake: true,
          flash: true,
          sound: "caught",
          vibrate: [220, 80, 220],
        };
      return {
        kind: "eliminated_other",
        title: `${nameOf(ctx, e.playerId)} eliminated`,
        subtitle: "Out of the safe zone.",
        tone: "info",
        durationMs: 2400,
        sound: "blip",
      };
    case "player_left":
      return e.playerId === ctx.myId
        ? null
        : { kind: "left", title: `${nameOf(ctx, e.playerId)} left`, tone: "info", durationMs: 2000 };
    case "red_zone_entered":
      return {
        kind: "red_zone",
        title: "Outside the safe zone",
        subtitle: `Get back inside within ${Math.round(e.graceMs / 1000)} seconds.`,
        tone: "danger",
        durationMs: 3200,
        sound: "alarm",
        vibrate: [100, 50, 100],
      };
    case "red_zone_cleared":
      return { kind: "red_clear", title: "Back inside", subtitle: "You're safe again.", tone: "good", durationMs: 1700, sound: "clear" };
    case "penalty_started":
      return {
        kind: "penalty",
        title: "Taking damage",
        subtitle: "Move into the safe zone now.",
        tone: "danger",
        durationMs: 2200,
        shake: true,
        sound: "alarm",
        vibrate: [160],
      };
  }
}
