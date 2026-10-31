import { destinationPoint, haversineM } from "../geo/distance";
import type { ZonePhaseConfig } from "../geo/zones";
import { RoomService, type ClientMessage, type Connection, type ServerMessage, type ServiceOptions } from "../server";
import type { LatLng, LocationReport } from "../shared/types";
import { Rng } from "./rng";
import { GOOD_GPS, type BotSpec, type GpsModel, type SimBot } from "./types";

export const SIM_START_MS = 1_800_000_000_000;

class BotConn implements Connection {
  closed = false;
  constructor(private readonly onMsg: (m: ServerMessage) => void) {}
  send(m: ServerMessage): void {
    if (!this.closed) this.onMsg(m);
  }
  close(): void {
    this.closed = true;
  }
}

export interface WorldOptions {
  seed: number;
  center: LatLng;
  radiusM: number;
  phases: readonly ZonePhaseConfig[];
  service?: ServiceOptions;
  bots: readonly BotSpec[];
}

/** A RoomService on a virtual clock plus simulated players. `step()` advances one second. */
export class SimWorld {
  readonly rng: Rng;
  readonly svc: RoomService;
  readonly bots: SimBot[] = [];
  readonly errors: Array<{ bot: string; code: string; message: string; tSec: number }> = [];
  tSec = 0;
  private nowMs = SIM_START_MS;
  private readonly conns = new Map<SimBot, BotConn>();
  /** Called for every message a bot receives. */
  onMessage: (bot: SimBot, msg: ServerMessage) => void = () => undefined;

  constructor(readonly opts: WorldOptions) {
    this.rng = new Rng(opts.seed);
    this.svc = new RoomService({
      now: () => this.nowMs,
      phases: opts.phases,
      minLocationIntervalMs: 500,
      ...opts.service,
    });
  }

  get now(): number {
    return this.nowMs;
  }

  host(): SimBot {
    return this.bots[0]!;
  }

  private makeConn(bot: SimBot): BotConn {
    const c = new BotConn((m) => {
      if (m.t === "welcome") Object.assign(bot, { playerId: m.playerId, token: m.token, code: m.code });
      if (m.t === "snapshot") bot.snapshot = m.snapshot;
      if (m.t === "error") this.errors.push({ bot: bot.spec.name, code: m.code, message: m.message, tSec: this.tSec });
      this.onMessage(bot, m);
    });
    this.conns.set(bot, c);
    return c;
  }

  private newBot(spec: BotSpec): SimBot {
    const gps: GpsModel = { ...GOOD_GPS, ...spec.gps };
    const truth = destinationPoint(this.opts.center, spec.start.bearing, spec.start.distanceM);
    return {
      spec, gps, playerId: "", token: "", code: "", truth, history: [truth], connected: true,
      snapshot: null, seen: {}, reportedLats: [],
    };
  }

  /** Create the room, join everyone, ready up, confirm the area and start the match. */
  setup(): void {
    const [hostSpec, ...rest] = this.opts.bots;
    if (!hostSpec) throw new Error("need at least one bot");
    const hostBot = this.newBot(hostSpec);
    this.bots.push(hostBot);
    const hostConn = this.makeConn(hostBot);
    this.svc.handle(hostConn, {
      t: "create", name: hostSpec.name, role: hostSpec.role, radiusM: this.opts.radiusM, consent: true,
      location: { lat: hostBot.truth.lat, lng: hostBot.truth.lng, accuracyM: 5 },
    });
    for (const spec of rest) {
      const bot = this.newBot(spec);
      this.bots.push(bot);
      this.svc.handle(this.makeConn(bot), {
        t: "join", code: hostBot.code, name: spec.name, role: spec.role, consent: true,
      });
    }
    this.nowMs += 1000;
    for (const b of this.bots) this.report(b, true);
    for (const b of this.bots) this.send(b, { t: "ready", ready: true });
    this.send(hostBot, { t: "confirm_safety" });
    this.send(hostBot, { t: "start" });
    for (const b of this.bots) this.report(b, true);
  }

  send(bot: SimBot, msg: ClientMessage): void {
    const c = this.conns.get(bot);
    if (!c || c.closed) return;
    this.svc.handle(c, msg);
  }

  /** Drop a bot's connection (phone loses signal / app backgrounded). */
  disconnect(bot: SimBot): void {
    const c = this.conns.get(bot);
    if (!c) return;
    this.svc.disconnect(c);
    c.close();
    bot.connected = false;
  }

  /** Bring the bot back with its resume token. */
  reconnect(bot: SimBot): void {
    const c = this.makeConn(bot);
    bot.connected = true;
    this.svc.handle(c, { t: "resume", token: bot.token });
  }

  /** Build a fix from the bot's true position using its GPS model. Null = no report this second. */
  private fix(bot: SimBot, force: boolean): LocationReport | null {
    const g = bot.gps;
    if (!force && this.rng.chance(g.dropout)) return null;
    let sigma = g.sigmaM;
    let accuracy = g.accuracyM;
    if (g.burst && this.tSec > 0 && this.tSec % g.burst.everyS < g.burst.lengthS) {
      sigma = g.burst.sigmaM;
      accuracy = g.burst.accuracyM;
    }
    let base = bot.truth;
    if (g.spoof && this.tSec >= g.spoof.atS && this.tSec < g.spoof.atS + g.spoof.forS)
      base = destinationPoint(bot.truth, 45, g.spoof.jumpM);
    const p = destinationPoint(base, this.rng.range(0, 360), Math.abs(this.rng.gauss(sigma)));
    const stale = !force && this.rng.chance(g.staleChance);
    return { lat: p.lat, lng: p.lng, accuracyM: accuracy, ageMs: stale ? 20_000 : Math.round(this.rng.range(0, 800)) };
  }

  private report(bot: SimBot, force = false): void {
    if (!bot.connected) return;
    const r = this.fix(bot, force);
    if (!r) return;
    bot.reportedLats.push(`"lat":${r.lat}`);
    if (bot.reportedLats.length > 40) bot.reportedLats.shift();
    this.send(bot, { t: "location", report: r });
  }

  /** Move every bot, send GPS, let killers tag, then tick the server. */
  step(act: (bot: SimBot) => { to: LatLng | null; capture?: string[] }): void {
    this.tSec += 1;
    this.nowMs += 1000;
    const moves = this.bots.map((b) => ({ b, m: act(b) }));
    for (const { b, m } of moves) {
      if (m.to) {
        const d = haversineM(b.truth, m.to);
        const stepM = Math.min(b.spec.speedMps, d);
        if (d > 0.01) {
          b.truth = destinationPoint(b.truth, bearing(b.truth, m.to), stepM);
        }
      }
      b.history[this.tSec] = b.truth;
    }
    for (const { b, m } of moves) {
      this.report(b);
      if (b.connected) for (const id of m.capture ?? []) this.send(b, { t: "capture", survivorId: id });
    }
    this.svc.tick();
  }
}

import { bearingDeg } from "../geo/distance";
const bearing = bearingDeg;
