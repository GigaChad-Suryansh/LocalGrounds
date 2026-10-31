import type { ClientMessage, ServerMessage } from "../../../src/server/protocol";

export type NetStatus = "idle" | "connecting" | "open" | "reconnecting";

export interface ConnectionHandlers {
  onMessage(msg: ServerMessage): void;
  onStatus(status: NetStatus): void;
}

export function defaultWsUrl(): string {
  const fromEnv = import.meta.env.VITE_WS_URL as string | undefined;
  if (fromEnv) return fromEnv;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

/** Backoff for reconnect attempt n (0-based): 0.5 s, 1 s, 2 s, 4 s, then 8 s. */
export const backoffMs = (attempt: number): number => Math.min(8000, 500 * 2 ** attempt);

/**
 * WebSocket client with queued sends and automatic reconnect. Once the server has issued a session
 * token, every reconnect starts with a `resume`, so a dropped signal doesn't cost a player their place.
 */
export class GameConnection {
  private ws: WebSocket | null = null;
  private queue: ClientMessage[] = [];
  private resumeToken: string | null = null;
  private closedByUser = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: ConnectionHandlers,
  ) {}

  setResumeToken(token: string | null): void {
    this.resumeToken = token;
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.open(this.attempt > 0 ? "reconnecting" : "connecting");
  }

  send(msg: ClientMessage): void {
    if (this.isOpen()) this.ws?.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  close(): void {
    this.closedByUser = true;
    this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
    this.attempt = 0;
    this.handlers.onStatus("idle");
  }

  private open(status: NetStatus): void {
    this.handlers.onStatus(status);
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.handlers.onStatus("open");
      if (this.resumeToken) ws.send(JSON.stringify({ t: "resume", token: this.resumeToken }));
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (ev) => {
      try {
        this.handlers.onMessage(JSON.parse(String(ev.data)) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUser) return;
      if (!this.resumeToken) {
        this.handlers.onStatus("idle");
        return;
      }
      this.handlers.onStatus("reconnecting");
      this.timer = setTimeout(() => this.open("reconnecting"), backoffMs(this.attempt++));
    };
    ws.onerror = () => undefined; // onclose follows and does the work
  }
}
