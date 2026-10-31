import type { CaptureRejection, GameEvent, KillerFacingOutcome, Role } from "../../../src/engine";
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
    case "captured":
      if (e.survivorId === ctx.myId)
        return {
          kind: "caught",
          title: "Caught",
          subtitle: `${nameOf(ctx, e.killerId)} tagged you.`,
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
          title: "Tagged",
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
        subtitle: `Tagged by ${nameOf(ctx, e.killerId)}.`,
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

/** Plain-language reason for a rejected tag (only reasons the killer is allowed to learn). */
export function captureRejectionText(reason: CaptureRejection): string {
  switch (reason) {
    case "match_not_active":
      return "The match isn't running.";
    case "not_a_killer":
      return "Only killers can tag.";
    case "killer_inactive":
      return "You're out of the match.";
    case "stale_location":
      return "Your GPS signal is stale. Move to open sky.";
    case "inaccurate_location":
    case "unreliable_location":
      return "Your GPS is too weak right now.";
    case "suspicious_location":
      return "Your location jumped. Wait a moment and try again.";
    default:
      return "Try again in a moment.";
  }
}

/** Feedback for the killer's own tag attempt. A success is announced by the capture event instead. */
export function captureResultFx(outcome: KillerFacingOutcome): FxDraft | null {
  switch (outcome.status) {
    case "captured":
      return null;
    case "pending":
      return {
        kind: "lock",
        title: "Lock-on",
        subtitle: `Hold position: ${outcome.hits} of ${outcome.required}.`,
        tone: "info",
        durationMs: 1700,
        sound: "blip",
        vibrate: [40],
      };
    case "miss":
      return { kind: "miss", title: "No contact", subtitle: "Nobody is in range yet.", tone: "warn", durationMs: 1700, vibrate: [30] };
    case "rejected":
      return {
        kind: "tag_rejected",
        title: "Can't tag",
        subtitle: captureRejectionText(outcome.reason),
        tone: "warn",
        durationMs: 2200,
      };
  }
}
