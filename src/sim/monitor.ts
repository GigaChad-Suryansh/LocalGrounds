import { DEFAULT_CAPTURE, DEFAULT_RED_ZONE, type GameEvent } from "../engine";
import { haversineM } from "../geo/distance";
import type { ServerMessage } from "../server";
import type { RoomInfo } from "../server/protocol";
import type { SimBot } from "./types";
import type { SimWorld } from "./world";

export interface Violation {
  tSec: number;
  rule: string;
  detail: string;
}

export interface SimStats {
  captures: number;
  eliminations: number;
  reveals: number;
  zoneShrinks: number;
  snapshots: number;
}

/** Margin (m) a player must be inside the safe zone to count as "comfortably inside". */
const COMFORT_M = 20;
const GUARDED = new Set(["captured", "eliminated", "zone_shrunk", "reveal_started"]);

/**
 * Watches everything the simulated clients receive and the world's true positions, and records a
 * violation whenever a rule the game promises is broken.
 */
export class Monitor {
  readonly violations: Violation[] = [];
  readonly stats: SimStats = { captures: 0, eliminations: 0, reveals: 0, zoneShrinks: 0, snapshots: 0 };
  readonly eliminated = new Set<string>();
  readonly captured = new Set<string>();
  room: RoomInfo | null = null;
  endReason: string | null = null;
  private readonly seenSeq = new Set<number>();
  private readonly lastInside = new Map<string, number>();
  private readonly byId = new Map<string, SimBot>();
  private pausedFor = 0;
  private pausedRadius: number | null = null;
  private stepGuarded = 0;

  constructor(private readonly world: SimWorld) {}

  private fail(rule: string, detail: string): void {
    if (this.violations.length < 50) this.violations.push({ tSec: this.world.tSec, rule, detail });
  }

  private bot(id: string): SimBot | undefined {
    if (!this.byId.has(id)) for (const b of this.world.bots) if (b.playerId) this.byId.set(b.playerId, b);
    return this.byId.get(id);
  }

  private get graceSeconds(): number {
    return this.world.opts.service?.gameConfig?.redZone?.graceSeconds ?? DEFAULT_RED_ZONE.graceSeconds;
  }

  onMessage(viewer: SimBot, msg: ServerMessage): void {
    if (msg.t === "snapshot") {
      this.stats.snapshots++;
      this.room = msg.room;
      this.checkSnapshot(viewer, msg);
    } else if (msg.t === "events") {
      const text = JSON.stringify(msg.events);
      if (/"lat"|"lng"/.test(text)) this.fail("leak", `an events message to ${viewer.spec.name} contains coordinates`);
      for (const e of msg.events) this.onEvent(e);
    }
    this.checkRawLeak(viewer, msg);
  }

  private checkSnapshot(viewer: SimBot, msg: Extract<ServerMessage, { t: "snapshot" }>): void {
    const s = msg.snapshot;
    if (s.matchPhase === "ended") this.endReason = s.endReason;
    for (const o of s.others) {
      if (!o.position) continue;
      const allowed =
        s.matchPhase === "active" &&
        s.self.status === "active" &&
        o.status === "active" &&
        (o.role === s.self.role || s.reveal?.active === true);
      if (!allowed)
        this.fail("leak", `${viewer.spec.name} was shown ${o.name}'s position (${s.matchPhase}, reveal=${s.reveal?.active})`);
    }
  }

  /** Belt and braces: no enemy's recent reported latitude may appear in any message outside a reveal. */
  private checkRawLeak(viewer: SimBot, msg: ServerMessage): void {
    if (msg.t === "snapshot" && msg.snapshot.reveal?.active) return;
    const enemies = this.world.bots.filter((b) => b !== viewer && b.spec.role !== viewer.spec.role);
    if (enemies.length === 0) return;
    const text = JSON.stringify(msg);
    if (!text.includes('"lat"')) return;
    for (const e of enemies)
      for (const needle of e.reportedLats.slice(-6))
        if (text.includes(needle)) {
          this.fail("leak", `${viewer.spec.name} received ${e.spec.name}'s reported position (${msg.t})`);
          return;
        }
  }

  private onEvent(e: GameEvent): void {
    if (e.audience === "all") {
      if (this.seenSeq.has(e.seq)) return;
      this.seenSeq.add(e.seq);
    }
    if (GUARDED.has(e.type)) this.stepGuarded++;
    switch (e.type) {
      case "captured":
        this.stats.captures++;
        this.captured.add(e.survivorId);
        this.checkCapture(e.killerId, e.survivorId);
        break;
      case "eliminated":
        this.stats.eliminations++;
        this.eliminated.add(e.playerId);
        this.checkElimination(e.playerId);
        break;
      case "reveal_started":
        this.stats.reveals++;
        break;
      case "zone_shrunk":
        this.stats.zoneShrinks++;
        break;
    }
  }

  private checkCapture(killerId: string, survivorId: string): void {
    const k = this.bot(killerId);
    const s = this.bot(survivorId);
    if (!k || !s) return;
    const sigma = Math.max(k.gps.sigmaM, s.gps.sigmaM, k.gps.burst?.sigmaM ?? 0, s.gps.burst?.sigmaM ?? 0);
    const limit = DEFAULT_CAPTURE.captureRadiusM + DEFAULT_CAPTURE.accuracyAllowanceCapM + 4.2 * sigma;
    let best = Infinity;
    for (let t = Math.max(0, this.world.tSec - 9); t <= this.world.tSec; t++) {
      const a = k.history[t];
      const b = s.history[t];
      if (a && b) best = Math.min(best, haversineM(a, b));
    }
    if (best > limit)
      this.fail("capture", `${k.spec.name} captured ${s.spec.name} but they were never closer than ${best.toFixed(0)} m (limit ${limit.toFixed(0)} m)`);
  }

  private checkElimination(playerId: string): void {
    const b = this.bot(playerId);
    if (!b) return;
    const since = this.world.tSec - (this.lastInside.get(playerId) ?? 0);
    if (since < this.graceSeconds - 1)
      this.fail("false_elimination", `${b.spec.name} eliminated ${since.toFixed(0)} s after being comfortably inside the safe zone (grace ${this.graceSeconds} s)`);
  }

  /** Per-second checks after the world has stepped. */
  afterStep(): void {
    const snap = this.world.host().snapshot;
    if (!snap) return;
    const radius = snap.zone?.safeZone.radiusM ?? snap.outer.radiusM;
    for (const b of this.world.bots) {
      if (haversineM(snap.outer.center, b.truth) <= radius - COMFORT_M) this.lastInside.set(b.playerId, this.world.tSec);
    }
    // Pause must freeze the match: no captures, eliminations, shrinks or scans while paused.
    if (snap.matchPhase === "paused") {
      if (this.pausedFor > 0 && this.stepGuarded > 0) this.fail("pause", "the match changed while paused");
      if (this.pausedRadius !== null && snap.zone && snap.zone.safeZone.radiusM !== this.pausedRadius)
        this.fail("pause", "the safe zone moved while paused");
      this.pausedRadius ??= snap.zone?.safeZone.radiusM ?? null;
      this.pausedFor++;
    } else {
      this.pausedFor = 0;
      this.pausedRadius = null;
    }
    this.stepGuarded = 0;
  }
}
