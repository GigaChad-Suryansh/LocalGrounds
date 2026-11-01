import { randomBytes, randomInt } from "node:crypto";
import { checkSample } from "../geo/freshness";
import { DEFAULT_PHASES, RADIUS_PRESETS_M, type ZonePhaseConfig } from "../geo/zones";
import {
  addPlayer,
  configureArena,
  confirmSafety,
  createGame,
  DEFAULT_GAME_CONFIG,
  drainEvents,
  endGame,
  evaluateStart,
  eventsFor,
  GameRuleError,
  ingestLocation,
  InvalidTransitionError,
  leaveGame,
  pauseGame,
  projectForViewer,
  resumeGame,
  setReady,
  startGame,
  tickGame,
  transferHost,
  type GameConfig,
  type GameState,
} from "../engine";
import type {
  ClientMessage,
  ErrorCode,
  RoomInfo,
  ServerMessage,
} from "./protocol";

/** Anything that can deliver messages to one client (a WebSocket, or a fake in tests). */
export interface Connection {
  send(msg: ServerMessage): void;
  close(): void;
}

export interface ServiceOptions {
  now?: () => number;
  maxRooms?: number;
  maxPlayersPerRoom?: number;
  minLocationIntervalMs?: number;
  /** Remove rooms with nobody connected after this long. */
  roomIdleTtlMs?: number;
  /** Remove finished rooms after this long. */
  endedRoomTtlMs?: number;
  phases?: readonly ZonePhaseConfig[];
  gameConfig?: Partial<GameConfig>;
}

export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

interface Room {
  code: string;
  game: GameState;
  /** secret token -> player id */
  tokens: Map<string, string>;
  conns: Map<string, Connection>;
  lastLocationMs: Map<string, number>;
  lastActivityMs: number;
  endedMs: number | null;
  /** Set once the final snapshot was sent and stored locations were wiped. */
  scrubbed: boolean;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0, 1

export class RoomService {
  private readonly now: () => number;
  private readonly opts: Required<Omit<ServiceOptions, "now" | "gameConfig">> & {
    gameConfig: GameConfig;
  };
  private readonly rooms = new Map<string, Room>();
  private readonly tokenIndex = new Map<string, { code: string; playerId: string }>();
  private readonly sessions = new Map<Connection, { code: string; playerId: string }>();

  constructor(options: ServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.opts = {
      maxRooms: options.maxRooms ?? 200,
      maxPlayersPerRoom: options.maxPlayersPerRoom ?? 12,
      minLocationIntervalMs: options.minLocationIntervalMs ?? 500,
      roomIdleTtlMs: options.roomIdleTtlMs ?? 10 * 60_000,
      endedRoomTtlMs: options.endedRoomTtlMs ?? 2 * 60_000,
      phases: options.phases ?? DEFAULT_PHASES,
      gameConfig: { ...DEFAULT_GAME_CONFIG, ...options.gameConfig },
    };
  }

  stats(): { rooms: number; connections: number } {
    return { rooms: this.rooms.size, connections: this.sessions.size };
  }

  // ------------------------------------------------------------ entry points

  handle(conn: Connection, msg: ClientMessage): void {
    try {
      this.dispatch(conn, msg);
    } catch (e) {
      if (e instanceof ProtocolError) {
        conn.send({ t: "error", code: e.code, message: e.message });
      } else if (e instanceof GameRuleError || e instanceof InvalidTransitionError) {
        conn.send({ t: "error", code: "rule_violation", message: e.message });
      } else {
        console.error("Unexpected error handling message:", e);
        conn.send({ t: "error", code: "internal", message: "Something went wrong." });
      }
    }
  }

  /** The transport dropped. The player keeps their place and can `resume` with their token. */
  disconnect(conn: Connection): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    this.sessions.delete(conn);
    const room = this.rooms.get(s.code);
    if (room && room.conns.get(s.playerId) === conn) room.conns.delete(s.playerId);
  }

  /** Call about once a second: advances match clocks, pushes fresh snapshots, cleans up. */
  tick(): void {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (room.game.match.phase === "active") room.game = tickGame(room.game, now);
      if (!room.scrubbed) this.broadcast(room);

      const expiredEnded = room.endedMs !== null && now - room.endedMs > this.opts.endedRoomTtlMs;
      const abandoned = room.conns.size === 0 && now - room.lastActivityMs > this.opts.roomIdleTtlMs;
      if (expiredEnded || abandoned) this.destroy(room);
    }
  }

  // ------------------------------------------------------------ dispatch

  private dispatch(conn: Connection, msg: ClientMessage): void {
    switch (msg.t) {
      case "create":
        return this.create(conn, msg);
      case "join":
        return this.join(conn, msg);
      case "resume":
        return this.resume(conn, msg.token);
      default:
        break;
    }

    const { room, playerId } = this.session(conn);
    const now = this.now();
    const g = room.game;

    switch (msg.t) {
      case "location": {
        const last = room.lastLocationMs.get(playerId);
        if (last !== undefined && now - last < this.opts.minLocationIntervalMs) {
          conn.send({ t: "location_ack", accepted: false, issues: [], rateLimited: true });
          return;
        }
        room.lastLocationMs.set(playerId, now);
        const r = ingestLocation(g, playerId, msg.report, now);
        room.game = r.state;
        room.lastActivityMs = now;
        conn.send({ t: "location_ack", accepted: r.accepted, issues: r.issues });
        return;
      }
      case "ready":
        return this.commit(room, setReady(g, playerId, msg.ready));
      case "configure":
        return this.commit(
          room,
          configureArena(g, playerId, {
            ...(msg.radiusM !== undefined ? { radiusM: msg.radiusM } : {}),
            ...(msg.captureRadiusM !== undefined ? { captureRadiusM: msg.captureRadiusM } : {}),
            ...(msg.lockSeconds !== undefined ? { lockSeconds: msg.lockSeconds } : {}),
          }),
        );
      case "confirm_safety":
        return this.commit(room, confirmSafety(g, playerId));
      case "start":
        return this.commit(room, startGame(g, playerId, now));
      case "pause":
        return this.commit(room, pauseGame(g, playerId, now));
      case "resume_match":
        return this.commit(room, resumeGame(g, playerId, now));
      case "end":
        return this.commit(room, endGame(g, playerId, now));
      case "leave":
        return this.leave(conn, room, playerId);
    }
  }

  private session(conn: Connection): { room: Room; playerId: string } {
    const s = this.sessions.get(conn);
    const room = s ? this.rooms.get(s.code) : undefined;
    if (!s || !room) throw new ProtocolError("not_in_room", "Create or join a room first.");
    return { room, playerId: s.playerId };
  }

  // ------------------------------------------------------------ create / join / resume

  private create(conn: Connection, msg: Extract<ClientMessage, { t: "create" }>): void {
    if (this.sessions.has(conn))
      throw new ProtocolError("already_in_room", "Leave your current room first.");
    if (this.rooms.size >= this.opts.maxRooms)
      throw new ProtocolError("server_full", "The server is full. Try again later.");

    const now = this.now();
    const check = checkSample(
      {
        lat: msg.location.lat,
        lng: msg.location.lng,
        accuracyM: msg.location.accuracyM,
        timestampMs: now - (msg.location.ageMs ?? 0),
      },
      now,
      this.opts.gameConfig.freshness,
    );
    if (!check.ok)
      throw new ProtocolError(
        "bad_location",
        `Your location isn't usable yet (${check.issues.join(", ")}). Move to open sky and try again.`,
      );

    const code = this.newCode();
    const playerId = this.newPlayerId();
    let game = createGame({
      hostId: playerId,
      hostName: msg.name,
      hostRole: msg.role,
      outer: {
        center: { lat: msg.location.lat, lng: msg.location.lng },
        radiusM: msg.radiusM,
      },
      phases: this.opts.phases,
      config: this.opts.gameConfig,
    });
    game = ingestLocation(game, playerId, msg.location, now).state;

    const room: Room = {
      code,
      game,
      tokens: new Map(),
      conns: new Map(),
      lastLocationMs: new Map([[playerId, now]]),
      lastActivityMs: now,
      endedMs: null,
      scrubbed: false,
    };
    this.rooms.set(code, room);
    this.admit(room, conn, playerId);
    this.commit(room, room.game);
  }

  private join(conn: Connection, msg: Extract<ClientMessage, { t: "join" }>): void {
    if (this.sessions.has(conn))
      throw new ProtocolError("already_in_room", "Leave your current room first.");
    const room = this.rooms.get(msg.code);
    if (!room) throw new ProtocolError("room_not_found", "No room with that code.");
    if (room.game.match.phase !== "lobby")
      throw new ProtocolError("already_started", "That match has already started.");
    if (Object.keys(room.game.players).length >= this.opts.maxPlayersPerRoom)
      throw new ProtocolError("room_full", "That room is full.");

    const playerId = this.newPlayerId(room);
    const game = addPlayer(room.game, { id: playerId, name: msg.name, role: msg.role });
    this.admit(room, conn, playerId);
    this.commit(room, game);
  }

  private resume(conn: Connection, token: string): void {
    const entry = this.tokenIndex.get(token);
    const room = entry ? this.rooms.get(entry.code) : undefined;
    const player = entry && room ? room.game.players[entry.playerId] : undefined;
    if (!entry || !room || !player || player.status === "left")
      throw new ProtocolError("invalid_token", "That session has expired.");

    const existing = this.sessions.get(conn);
    if (existing && existing.playerId !== entry.playerId)
      throw new ProtocolError("already_in_room", "Leave your current room first.");

    const old = room.conns.get(entry.playerId);
    if (old && old !== conn) {
      this.sessions.delete(old);
      old.close();
    }
    room.conns.set(entry.playerId, conn);
    this.sessions.set(conn, { code: room.code, playerId: entry.playerId });
    room.lastActivityMs = this.now();
    conn.send({ t: "welcome", token, playerId: entry.playerId, code: room.code });
    conn.send(this.snapshotMessage(room, entry.playerId, this.now()));
  }

  /** Register a connection as a player and hand them their secret token. */
  private admit(room: Room, conn: Connection, playerId: string): void {
    const token = randomBytes(16).toString("hex");
    room.tokens.set(token, playerId);
    this.tokenIndex.set(token, { code: room.code, playerId });
    room.conns.set(playerId, conn);
    this.sessions.set(conn, { code: room.code, playerId });
    conn.send({ t: "welcome", token, playerId, code: room.code });
  }

  private leave(conn: Connection, room: Room, playerId: string): void {
    const now = this.now();
    let game = leaveGame(room.game, playerId, now);

    // Forget the player's credentials and connection.
    for (const [token, id] of room.tokens) {
      if (id === playerId) {
        room.tokens.delete(token);
        this.tokenIndex.delete(token);
      }
    }
    room.conns.delete(playerId);
    this.sessions.delete(conn);
    conn.send({ t: "left" });

    // If the host left, pass the role on so pauses can always be resumed.
    if (game.hostId === playerId && game.match.phase !== "ended") {
      const next = Object.values(game.players).find((p) => p.status === "active");
      if (next) game = transferHost(game, next.id);
    }
    this.commit(room, game);
  }

  // ------------------------------------------------------------ broadcasting

  private commit(room: Room, game: GameState): void {
    room.game = game;
    room.lastActivityMs = this.now();
    this.broadcast(room);
  }

  private roomInfo(room: Room): RoomInfo {
    return {
      code: room.code,
      hostId: room.game.hostId,
      maxPlayers: this.opts.maxPlayersPerRoom,
      radiusPresetsM: [...RADIUS_PRESETS_M],
      captureRadiusM: room.game.config.capture.captureRadiusM,
      lockSeconds: room.game.config.capture.lockSeconds,
      revealIntervalMs: room.game.config.reveal.intervalMs,
      revealDurationMs: room.game.config.reveal.durationMs,
    };
  }

  private snapshotMessage(room: Room, playerId: string, now: number): ServerMessage {
    const game = room.game;
    const msg: ServerMessage = {
      t: "snapshot",
      snapshot: projectForViewer(game, playerId, now),
      room: this.roomInfo(room),
    };
    if (playerId === game.hostId && game.match.phase === "lobby")
      msg.startCheck = evaluateStart(game, now);
    return msg;
  }

  /**
   * Send every connected player THEIR view of the game and THEIR events.
   * Nothing here ever serialises raw GameState: it all goes through
   * projectForViewer / eventsFor.
   */
  private broadcast(room: Room): void {
    const now = this.now();
    const { state, events } = drainEvents(room.game);
    room.game = state;

    for (const [playerId, conn] of room.conns) {
      conn.send(this.snapshotMessage(room, playerId, now));
      const mine = eventsFor(playerId, events);
      if (mine.length > 0) conn.send({ t: "events", events: mine });
    }

    // Privacy: once the match is over and everyone has the final state, wipe stored locations.
    if (room.game.match.phase === "ended" && !room.scrubbed) {
      const players = Object.fromEntries(
        Object.entries(room.game.players).map(([id, p]) => [id, { ...p, sample: null }]),
      );
      room.game = { ...room.game, players };
      room.scrubbed = true;
      room.endedMs = now;
    }
  }

  private destroy(room: Room): void {
    for (const conn of room.conns.values()) {
      this.sessions.delete(conn);
      conn.close();
    }
    for (const token of room.tokens.keys()) this.tokenIndex.delete(token);
    this.rooms.delete(room.code);
  }

  // ------------------------------------------------------------ ids

  private newCode(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = "";
      for (let i = 0; i < 5; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new ProtocolError("server_full", "Could not allocate a room code.");
  }

  private newPlayerId(room?: Room): string {
    for (;;) {
      const id = `p_${randomBytes(4).toString("hex")}`;
      if (!room || !room.game.players[id]) return id;
    }
  }
}
