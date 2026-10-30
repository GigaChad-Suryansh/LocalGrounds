import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startServer, type RunningServer, type ServerMessage } from "../src/server";
import { CENTER } from "./helpers";

class Client {
  readonly msgs: ServerMessage[] = [];
  closeCode: number | null = null;
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (d) => this.msgs.push(JSON.parse(d.toString()) as ServerMessage));
    this.ws.on("close", (code) => {
      this.closeCode = code;
    });
    this.ws.on("error", () => undefined);
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }

  sendRaw(data: string | Buffer, binary = false): void {
    this.ws.send(data, { binary });
  }

  close(): void {
    this.ws.close();
  }

  async until<T>(fn: () => T | undefined | false | null, ms = 3000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out; messages: ${JSON.stringify(this.msgs)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  find<T extends ServerMessage["t"]>(t: T) {
    return () => this.msgs.find((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

let server: RunningServer;
let url: string;
const clients: Client[] = [];

async function connect(): Promise<Client> {
  const c = new Client(url);
  clients.push(c);
  await c.opened();
  return c;
}

const create = {
  t: "create",
  name: "Host",
  role: "killer",
  radiusM: 150,
  consent: true,
  location: { lat: CENTER.lat, lng: CENTER.lng, accuracyM: 5 },
};

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", tickMs: 50 });
  url = `ws://127.0.0.1:${server.port}/ws`;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await server.close();
});

describe("WebSocket server (real sockets)", () => {
  it("answers health checks", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect((await fetch(`http://127.0.0.1:${server.port}/nope`)).status).toBe(404);
  });

  it("creates a room and lets a second player join, each seeing their own view", async () => {
    const host = await connect();
    host.send(create);
    const welcome = await host.until(host.find("welcome"));
    expect(welcome.code).toMatch(/^[A-Z0-9]{5}$/);
    const first = await host.until(host.find("snapshot"));
    expect(first.snapshot.outer.center.lat).toBe(CENTER.lat);

    const guest = await connect();
    guest.send({ t: "join", code: welcome.code, name: "Sam", role: "survivor", consent: true });
    const gw = await guest.until(guest.find("welcome"));
    expect(gw.playerId).not.toBe(welcome.playerId);

    await host.until(() =>
      host.msgs.some((m) => m.t === "snapshot" && m.snapshot.others.some((o) => o.name === "Sam")),
    );
    const guestSnap = await guest.until(guest.find("snapshot"));
    expect(guestSnap.snapshot.self.role).toBe("survivor");
    expect(guestSnap.startCheck).toBeUndefined();
  });

  it("pushes snapshots on the server tick without being asked", async () => {
    const host = await connect();
    host.send(create);
    await host.until(host.find("snapshot"));
    const n = host.msgs.filter((m) => m.t === "snapshot").length;
    await host.until(() => host.msgs.filter((m) => m.t === "snapshot").length >= n + 2);
  });

  it("resumes a dropped session with the token", async () => {
    const first = await connect();
    first.send(create);
    const welcome = await first.until(first.find("welcome"));
    first.close();
    await first.until(() => first.closeCode !== null);
    await new Promise((r) => setTimeout(r, 50)); // let the server notice the drop

    const second = await connect();
    second.send({ t: "resume", token: welcome.token });
    const again = await second.until(second.find("welcome"));
    expect(again.playerId).toBe(welcome.playerId);
    expect(again.code).toBe(welcome.code);
    const snap = await second.until(second.find("snapshot"));
    expect(snap.snapshot.self.id).toBe(welcome.playerId);
  });

  it("rejects bad input without crashing or closing the connection", async () => {
    const c = await connect();
    c.sendRaw("not json {");
    await c.until(() => c.msgs.find((m) => m.t === "error" && m.message === "Invalid JSON."));

    c.send({ t: "launch_missiles" });
    await c.until(() => c.msgs.find((m) => m.t === "error" && m.message === "Unknown message type."));

    c.send({ ...create, consent: false });
    await c.until(() => c.msgs.find((m) => m.t === "error" && /consent/i.test(m.message)));

    c.sendRaw(Buffer.from([1, 2, 3]), true);
    await c.until(() => c.msgs.find((m) => m.t === "error" && /Text messages only/.test(m.message)));

    c.send({ t: "start" }); // valid shape, but not in a room
    await c.until(() => c.msgs.find((m) => m.t === "error" && m.code === "not_in_room"));
    expect(c.closeCode).toBeNull();
  });

  it("drops oversized messages", async () => {
    const c = await connect();
    c.sendRaw("x".repeat(20_000));
    await c.until(() => c.closeCode !== null);
    expect(c.closeCode).toBe(1009);
  });

  it("disconnects clients that flood the server", async () => {
    const c = await connect();
    for (let i = 0; i < 60; i++) c.send({ t: "leave" });
    await c.until(() => c.closeCode !== null);
    expect(c.closeCode).toBe(1008);
  });
});
