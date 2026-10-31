import { describe, it, expect } from "vitest";
import {
  RoomService,
  type ClientMessage,
  type Connection,
  type ServerMessage,
  type ServiceOptions,
} from "../src/server";
import type { GameState } from "../src/engine";
import type { ZonePhaseConfig } from "../src/geo/zones";
import type { LatLng } from "../src/shared/types";
import type { Role } from "../src/engine";
import { CENTER, LONG_PHASES, NOW, SEC, at } from "./helpers";

class FakeConn implements Connection {
  msgs: ServerMessage[] = [];
  closed = false;
  send(m: ServerMessage): void {
    this.msgs.push(m);
  }
  close(): void {
    this.closed = true;
  }
  of<T extends ServerMessage["t"]>(t: T): Array<Extract<ServerMessage, { t: T }>> {
    return this.msgs.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
  last<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return this.of(t).at(-1);
  }
  events() {
    return this.of("events").flatMap((m) => m.events);
  }
}

interface Client {
  conn: FakeConn;
  playerId: string;
  token: string;
  code: string;
}

const loc = (p: LatLng, accuracyM = 5) => ({ lat: p.lat, lng: p.lng, accuracyM });

function world(opts: ServiceOptions = {}) {
  const clock = { now: NOW };
  const svc = new RoomService({ now: () => clock.now, phases: LONG_PHASES, ...opts });
  const advance = (sec: number) => {
    clock.now += sec * SEC;
  };
  const send = (c: Client | FakeConn, msg: ClientMessage) =>
    svc.handle(c instanceof FakeConn ? c : c.conn, msg);
  return { svc, clock, advance, send };
}
type World = ReturnType<typeof world>;

function fromWelcome(conn: FakeConn): Client {
  const w = conn.last("welcome");
  if (!w) throw new Error(`no welcome, got ${JSON.stringify(conn.msgs)}`);
  return { conn, playerId: w.playerId, token: w.token, code: w.code };
}

function host(w: World, role: Role = "killer", pos: LatLng = CENTER, radiusM = 150): Client {
  const conn = new FakeConn();
  w.send(conn, { t: "create", name: "Host", role, radiusM, consent: true, location: loc(pos) });
  return fromWelcome(conn);
}

function guest(w: World, code: string, role: Role, name = "Guest"): Client {
  const conn = new FakeConn();
  w.send(conn, { t: "join", code, name, role, consent: true });
  return fromWelcome(conn);
}

/** Host (killer at the centre) + one survivor, everyone ready, area confirmed, match started. */
function startedDuel(w: World, survivorPos: LatLng = at(180, 100)) {
  const h = host(w, "killer");
  const s = guest(w, h.code, "survivor", "Sam");
  w.advance(1);
  w.send(s, { t: "location", report: loc(survivorPos) });
  w.send(h, { t: "ready", ready: true });
  w.send(s, { t: "ready", ready: true });
  w.send(h, { t: "confirm_safety" });
  w.send(h, { t: "start" });
  return { h, s };
}

/** Advance `sec` seconds, then report fresh positions for the given clients. */
function move(w: World, sec: number, ...updates: Array<[Client, LatLng]>) {
  w.advance(sec);
  for (const [c, p] of updates) w.send(c, { t: "location", report: loc(p) });
}

const lastError = (c: Client | FakeConn) => (c instanceof FakeConn ? c : c.conn).last("error");
const snap = (c: Client) => {
  const m = c.conn.last("snapshot");
  if (!m) throw new Error("no snapshot");
  return m;
};
const leaks = (c: Client, p: LatLng) => JSON.stringify(c.conn.msgs).includes(`"lat":${p.lat}`);

// ----------------------------------------------------------------------------------

describe("creating and joining rooms", () => {
  it("creates a room centred on the host's GPS position and issues a secret token", () => {
    const w = world();
    const h = host(w, "killer", CENTER, 75);
    expect(h.code).toMatch(/^[A-HJKMNP-Z2-9]{5}$/);
    expect(h.token).toMatch(/^[a-f0-9]{32}$/);

    const s = snap(h);
    expect(s.snapshot.matchPhase).toBe("lobby");
    expect(s.snapshot.outer).toEqual({ center: { lat: CENTER.lat, lng: CENTER.lng }, radiusM: 75 });
    expect(s.snapshot.self.id).toBe(h.playerId);
    expect(s.room.hostId).toBe(h.playerId);
    expect(s.room.radiusPresetsM).toEqual([30, 75, 150, 300]);
    expect(s.startCheck?.canStart).toBe(false);
    expect(w.svc.stats()).toEqual({ rooms: 1, connections: 1 });
  });

  it("refuses to create a room from an unreliable location", () => {
    const w = world();
    const conn = new FakeConn();
    w.send(conn, { t: "create", name: "Host", role: "killer", radiusM: 150, consent: true, location: loc(CENTER, 120) });
    expect(lastError(conn)).toMatchObject({ code: "bad_location" });
    w.send(conn, {
      t: "create",
      name: "Host",
      role: "killer",
      radiusM: 150,
      consent: true,
      location: { ...loc(CENTER), ageMs: 60_000 },
    });
    expect(lastError(conn)).toMatchObject({ code: "bad_location" });
    expect(w.svc.stats().rooms).toBe(0);
  });

  it("lets players join with a code; the host is notified", () => {
    const w = world();
    const h = host(w);
    const s = guest(w, h.code, "survivor", "Sam");
    expect(snap(s).snapshot.others.map((o) => o.name)).toEqual(["Host"]);
    expect(snap(h).snapshot.others.map((o) => o.name)).toEqual(["Sam"]);
  });

  it("rejects unknown codes, full rooms, started matches and double joins", () => {
    const w = world({ maxPlayersPerRoom: 2 });
    const stray = new FakeConn();
    w.send(stray, { t: "join", code: "ZZZZZ", name: "X", role: "survivor", consent: true });
    expect(lastError(stray)).toMatchObject({ code: "room_not_found" });

    const h = host(w);
    guest(w, h.code, "survivor");
    const third = new FakeConn();
    w.send(third, { t: "join", code: h.code, name: "Third", role: "survivor", consent: true });
    expect(lastError(third)).toMatchObject({ code: "room_full" });

    w.send(h.conn, { t: "create", name: "Again", role: "killer", radiusM: 30, consent: true, location: loc(CENTER) });
    expect(lastError(h)).toMatchObject({ code: "already_in_room" });

    const w2 = world();
    startedDuel(w2);
    const code = [...(w2.svc as unknown as { rooms: Map<string, unknown> }).rooms.keys()][0] as string;
    const late = new FakeConn();
    w2.send(late, { t: "join", code, name: "Late", role: "survivor", consent: true });
    expect(lastError(late)).toMatchObject({ code: "already_started" });
  });

  it("limits the number of rooms", () => {
    const w = world({ maxRooms: 1 });
    host(w);
    const second = new FakeConn();
    w.send(second, { t: "create", name: "B", role: "killer", radiusM: 30, consent: true, location: loc(CENTER) });
    expect(lastError(second)).toMatchObject({ code: "server_full" });
  });

  it("ignores gameplay messages from connections that are not in a room", () => {
    const w = world();
    const stray = new FakeConn();
    for (const msg of [
      { t: "ready", ready: true },
      { t: "start" },
      { t: "location", report: loc(CENTER) },
      { t: "pause" },
    ] satisfies ClientMessage[]) {
      w.send(stray, msg);
      expect(lastError(stray)).toMatchObject({ code: "not_in_room" });
    }
  });
});

describe("host controls and start rules", () => {
  it("only the host can configure, confirm safety, start, or end", () => {
    const w = world();
    const h = host(w);
    const s = guest(w, h.code, "survivor");
    for (const msg of [
      { t: "configure", radiusM: 75 },
      { t: "confirm_safety" },
      { t: "start" },
      { t: "end" },
    ] satisfies ClientMessage[]) {
      w.send(s, msg);
      expect(lastError(s)).toMatchObject({ code: "rule_violation" });
    }
  });

  it("resizing the arena withdraws the safety confirmation", () => {
    const w = world();
    const h = host(w);
    w.send(h, { t: "confirm_safety" });
    expect(snap(h).snapshot.safetyConfirmed).toBe(true);
    w.send(h, { t: "configure", radiusM: 75, captureRadiusM: 12 });
    expect(snap(h).snapshot.safetyConfirmed).toBe(false);
    expect(snap(h).snapshot.outer.radiusM).toBe(75);
    expect(snap(h).room.captureRadiusM).toBe(12);
  });

  it("explains what is blocking the start, and only to the host", () => {
    const w = world();
    const h = host(w);
    const s = guest(w, h.code, "survivor");
    w.send(h, { t: "start" });
    expect(lastError(h)).toMatchObject({ code: "rule_violation" });
    expect(lastError(h)?.message).toMatch(/Cannot start/);

    const check = snap(h).startCheck;
    expect(check?.blockers).toEqual(
      expect.arrayContaining(["safety_not_confirmed", "players_not_ready", "players_ineligible"]),
    );
    expect(check?.players.find((p) => p.playerId === s.playerId)?.issues).toContain("no_location");
    expect(snap(s).startCheck).toBeUndefined();
  });

  it("starts once everyone is ready, located, and the host confirmed the area", () => {
    const w = world();
    const { h, s } = startedDuel(w);
    expect(snap(h).snapshot.matchPhase).toBe("active");
    expect(snap(s).snapshot.matchPhase).toBe("active");
    expect(snap(h).startCheck).toBeUndefined();
    for (const c of [h, s]) expect(c.conn.events().map((e) => e.type)).toContain("match_started");
  });

  it("the host role passes on when the host leaves, and the leaver's token dies", () => {
    const w = world();
    const h = host(w);
    const s = guest(w, h.code, "survivor");
    w.send(h, { t: "leave" });
    expect(h.conn.last("left")).toBeDefined();
    expect(snap(s).room.hostId).toBe(s.playerId);
    expect(snap(s).snapshot.others.find((o) => o.id === h.playerId)?.status).toBe("left");

    const back = new FakeConn();
    w.send(back, { t: "resume", token: h.token });
    expect(lastError(back)).toMatchObject({ code: "invalid_token" });
  });
});

describe("identity comes from the connection, never from the message", () => {
  it("a token resumes only its own player", () => {
    const w = world();
    const h = host(w);
    const s = guest(w, h.code, "survivor");
    const impostor = new FakeConn();
    w.send(impostor, { t: "resume", token: s.token });
    expect(impostor.last("welcome")?.playerId).toBe(s.playerId);
    expect(impostor.last("snapshot")?.snapshot.self.role).toBe("survivor");
    expect(s.conn.closed).toBe(true);
    // the displaced connection is no longer authenticated
    w.send(s, { t: "ready", ready: true });
    expect(lastError(s)).toMatchObject({ code: "not_in_room" });
  });

  it("rejects well-formed but unknown tokens", () => {
    const w = world();
    host(w);
    const c = new FakeConn();
    w.send(c, { t: "resume", token: "0".repeat(32) });
    expect(lastError(c)).toMatchObject({ code: "invalid_token" });
  });

  it("a dropped player keeps their place and can resume", () => {
    const w = world();
    const { h, s } = startedDuel(w);
    w.svc.disconnect(s.conn);
    expect(w.svc.stats().connections).toBe(1);
    w.svc.tick(); // must not try to send to the dead connection
    const sBefore = s.conn.msgs.length;
    w.svc.tick();
    expect(s.conn.msgs.length).toBe(sBefore);

    const again = new FakeConn();
    w.send(again, { t: "resume", token: s.token });
    expect(again.last("welcome")?.playerId).toBe(s.playerId);
    expect(again.last("snapshot")?.snapshot.matchPhase).toBe("active");
    expect(snap(h).snapshot.matchPhase).toBe("active");
  });
});

describe("what each client is allowed to receive", () => {
  it("never sends survivor coordinates to a killer before a reveal (checked over the raw message log)", () => {
    const w = world();
    const survivorPos = at(180, 100);
    const { h, s } = startedDuel(w, survivorPos);
    for (let i = 0; i < 6; i++) {
      move(w, 10, [h, CENTER], [s, survivorPos]);
      w.svc.tick();
    }
    expect(leaks(s, survivorPos)).toBe(true); // a player does receive their own position
    expect(leaks(h, survivorPos)).toBe(false); // the killer never does
    const others = snap(h).snapshot.others;
    expect(others).toHaveLength(1);
    expect(others[0]?.position).toBeNull();
  });

  it("reveals positions during the 120 s window and hides them again after", () => {
    const w = world();
    const survivorPos = at(180, 100);
    const { h, s } = startedDuel(w, survivorPos);

    move(w, 124, [h, CENTER], [s, survivorPos]);
    w.advance(1); // match time ≈ 125 s: inside the first reveal window
    w.svc.tick();
    expect(snap(h).snapshot.reveal?.active).toBe(true);
    expect(snap(h).snapshot.others[0]?.position?.lat).toBe(survivorPos.lat);
    expect(h.conn.events().map((e) => e.type)).toContain("reveal_started");

    move(w, 15, [h, CENTER], [s, survivorPos]);
    w.svc.tick();
    expect(snap(h).snapshot.reveal?.active).toBe(false);
    expect(snap(h).snapshot.others[0]?.position).toBeNull();
    expect(h.conn.events().map((e) => e.type)).toContain("reveal_ended");
  });

  it("delivers private events only to the player they concern", () => {
    const w = world({
      phases: [
        { radiusFraction: 1, holdSeconds: 60, warningSeconds: 0 },
        { radiusFraction: 0.5, holdSeconds: 600, warningSeconds: 20 },
      ] satisfies ZonePhaseConfig[],
    });
    const survivorPos = at(180, 100); // outside the 75 m zone once it shrinks
    const { h, s } = startedDuel(w, survivorPos);
    move(w, 60, [h, CENTER], [s, survivorPos]);
    move(w, 2, [h, CENTER], [s, survivorPos]);
    w.svc.tick(); // events raised by a location report are pushed on the next tick

    expect(s.conn.events().map((e) => e.type)).toContain("red_zone_entered");
    expect(snap(s).snapshot.self.redZone.status).toBe("warning");
    expect(h.conn.events().map((e) => e.type)).not.toContain("red_zone_entered");
  });
});

describe("Radar Lock through the service", () => {
  const progress = (c: Client, who: "killer" | "survivor"): number | null =>
    who === "killer"
      ? (snap(c).snapshot.radar.lockedOn[0]?.progressMs ?? null)
      : (snap(c).snapshot.radar.lockedBy?.progressMs ?? null);

  it("fills by server time, shows the same progress to both clients, and ends the match", () => {
    const w = world();
    const near = at(0, 10);
    const { h, s } = startedDuel(w, near);

    const seen: Array<number | null> = [];
    for (let i = 0; i < 4; i++) {
      move(w, 1, [h, CENTER], [s, near]);
      w.svc.tick();
      expect(snap(h).snapshot.matchPhase).toBe("active");
      seen.push(progress(h, "killer"));
      expect(progress(s, "survivor")).toBe(progress(h, "killer")); // clients agree
    }
    expect(seen).toEqual([0, 1000, 2000, 3000]);
    expect(snap(h).snapshot.radar.lockMs).toBe(4000);
    expect(h.conn.events().map((e) => e.type)).toContain("lock_started");
    expect(s.conn.events().map((e) => e.type)).toContain("radar_locked_on");
    expect(snap(s).snapshot.self.status).toBe("active");

    move(w, 1, [h, CENTER], [s, near]);
    w.svc.tick();
    expect(snap(h).snapshot.matchPhase).toBe("ended");
    expect(snap(h).snapshot.endReason).toBe("all_captured");
    expect(snap(s).snapshot.self.status).toBe("captured");
    for (const c of [h, s]) expect(c.conn.events().map((e) => e.type)).toEqual(
      expect.arrayContaining(["captured", "match_ended"]),
    );
  });

  it("cannot be completed by silence: stale locations never capture", () => {
    const w = world();
    const near = at(0, 10);
    const { h, s } = startedDuel(w, near);
    move(w, 1, [h, CENTER], [s, near]);
    w.svc.tick();
    for (let i = 0; i < 30; i++) {
      w.advance(1);
      w.svc.tick();
    }
    expect(snap(s).snapshot.self.status).toBe("active");
    expect(snap(h).snapshot.radar.lockedOn).toEqual([]);
  });

  it("a client has no way to claim a capture", () => {
    const w = world();
    const { h, s } = startedDuel(w, at(0, 10));
    w.send(h, { t: "capture", survivorId: s.playerId } as unknown as ClientMessage);
    w.send(h, { t: "captured", survivorId: s.playerId } as unknown as ClientMessage);
    expect(snap(s).snapshot.self.status).toBe("active");
  });
});

describe("rate limiting", () => {
  it("throttles location reports", () => {
    const w = world();
    const h = host(w);
    w.advance(1);
    w.send(h, { t: "location", report: loc(CENTER) });
    expect(h.conn.last("location_ack")).toMatchObject({ accepted: true });
    w.send(h, { t: "location", report: loc(CENTER) });
    expect(h.conn.last("location_ack")).toMatchObject({ accepted: false, rateLimited: true });
    w.advance(1);
    w.send(h, { t: "location", report: loc(CENTER) });
    expect(h.conn.last("location_ack")).toMatchObject({ accepted: true });
  });

  it("tells the player when their GPS is too weak, instead of silently accepting it as good", () => {
    const w = world();
    const h = host(w);
    w.advance(1);
    w.send(h, { t: "location", report: loc(CENTER, 90) });
    const ack = h.conn.last("location_ack");
    expect(ack?.issues).toContain("inaccurate");
    w.svc.tick(); // snapshots are pushed on the next tick
    expect(snap(h).snapshot.self.locationIssues).toContain("inaccurate");
  });
});

describe("clock, cleanup and privacy after the match", () => {
  it("ends the match on timeout and tells everyone", () => {
    const w = world();
    const { h, s } = startedDuel(w);
    w.advance(601);
    w.svc.tick();
    for (const c of [h, s]) {
      expect(c.conn.events().find((e) => e.type === "match_ended")).toMatchObject({ reason: "timeout" });
      expect(snap(c).snapshot.matchPhase).toBe("ended");
    }
  });

  it("wipes stored locations once the match is over, then removes the room", () => {
    const w = world();
    const { h } = startedDuel(w);
    w.send(h, { t: "end" });
    expect(snap(h).snapshot.endReason).toBe("host_ended");

    const rooms = (w.svc as unknown as { rooms: Map<string, { game: GameState }> }).rooms;
    const room = [...rooms.values()][0];
    expect(Object.values(room?.game.players ?? {}).every((p) => p.sample === null)).toBe(true);

    w.advance(60);
    w.svc.tick();
    expect(w.svc.stats().rooms).toBe(1);
    w.advance(61);
    w.svc.tick();
    expect(w.svc.stats()).toEqual({ rooms: 0, connections: 0 });
    expect(h.conn.closed).toBe(true);
  });

  it("removes rooms that everyone abandoned", () => {
    const w = world();
    const h = host(w);
    w.svc.disconnect(h.conn);
    w.advance(5 * 60);
    w.svc.tick();
    expect(w.svc.stats().rooms).toBe(1);
    w.advance(6 * 60);
    w.svc.tick();
    expect(w.svc.stats().rooms).toBe(0);
    const c = new FakeConn();
    w.send(c, { t: "resume", token: h.token });
    expect(lastError(c)).toMatchObject({ code: "invalid_token" });
  });

  it("any player can trigger an emergency pause; only the host resumes", () => {
    const w = world();
    const { h, s } = startedDuel(w);
    w.send(s, { t: "pause" });
    expect(snap(h).snapshot.matchPhase).toBe("paused");
    w.send(s, { t: "resume_match" });
    expect(lastError(s)).toMatchObject({ code: "rule_violation" });
    w.send(h, { t: "resume_match" });
    expect(snap(s).snapshot.matchPhase).toBe("active");
  });
});
