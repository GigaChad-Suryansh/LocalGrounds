import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffMs, GameConnection, type NetStatus } from "../web/src/net/connection";
import type { ServerMessage } from "../src/server/protocol";

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = FakeWS.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  // helpers used by the tests
  open(): void {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(m: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const token = "b".repeat(32);

describe("reconnecting connection", () => {
  let statuses: NetStatus[];
  let received: ServerMessage[];
  let conn: GameConnection;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    vi.stubGlobal("WebSocket", FakeWS);
    statuses = [];
    received = [];
    conn = new GameConnection("ws://test/ws", {
      onStatus: (s) => statuses.push(s),
      onMessage: (m) => received.push(m),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const sock = (i = FakeWS.instances.length - 1) => FakeWS.instances[i] as FakeWS;

  it("queues messages until the socket opens, then sends them in order", () => {
    conn.connect();
    conn.send({ t: "ready", ready: true });
    conn.send({ t: "start" });
    expect(sock().sent).toEqual([]);
    sock().open();
    expect(sock().sent.map((s) => JSON.parse(s).t)).toEqual(["ready", "start"]);
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("does not open a second socket when already connecting or open", () => {
    conn.connect();
    conn.connect();
    sock().open();
    conn.connect();
    expect(FakeWS.instances).toHaveLength(1);
  });

  it("delivers parsed server messages and ignores garbage", () => {
    conn.connect();
    sock().open();
    sock().receive({ t: "left" });
    sock().onmessage?.({ data: "not json" });
    expect(received).toEqual([{ t: "left" }]);
  });

  it("resumes first, then flushes the queue, after a drop", () => {
    conn.setResumeToken(token);
    conn.connect();
    sock().open();
    sock().drop();
    expect(statuses.at(-1)).toBe("reconnecting");
    conn.send({ t: "pause" }); // sent while offline
    vi.advanceTimersByTime(backoffMs(0));
    expect(FakeWS.instances).toHaveLength(2);
    sock().open();
    expect(sock().sent.map((s) => JSON.parse(s).t)).toEqual(["resume", "pause"]);
    expect(JSON.parse(sock().sent[0] as string).token).toBe(token);
  });

  it("backs off between attempts and resets after a successful open", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
    conn.setResumeToken(token);
    conn.connect();
    sock().open();
    sock().drop();
    vi.advanceTimersByTime(500);
    sock().drop(); // second attempt fails before opening
    vi.advanceTimersByTime(999);
    expect(FakeWS.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWS.instances).toHaveLength(3);
    sock().open();
    sock().drop();
    vi.advanceTimersByTime(500); // back to the first delay
    expect(FakeWS.instances).toHaveLength(4);
  });

  it("does not reconnect when there is no session to resume", () => {
    conn.connect();
    sock().open();
    sock().drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe("idle");
  });

  it("stops for good when the user closes it, and can be reopened later", () => {
    conn.setResumeToken(token);
    conn.connect();
    sock().open();
    conn.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe("idle");
    conn.connect();
    expect(FakeWS.instances).toHaveLength(2);
  });
});
