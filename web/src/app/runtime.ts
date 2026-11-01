import { GpsTracker } from "../device/tracker";
import { keepAwake } from "../device/wakeLock";
import { unlockAudio } from "../device/sound";
import { canHost } from "../lib/gps";
import { defaultWsUrl, GameConnection } from "../net/connection";
import { createStore, type Session } from "../state/store";
import type { Role } from "../../../src/engine";

const SESSION_KEY = "lg.session";

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    return typeof s.token === "string" && typeof s.playerId === "string" && typeof s.code === "string"
      ? { token: s.token, playerId: s.playerId, code: s.code }
      : null;
  } catch {
    return null;
  }
}
function saveSession(s: Session | null): void {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: the session just won't survive a reload */
  }
}

export const store = createStore();

const conn: GameConnection = new GameConnection(defaultWsUrl(), {
  onStatus: (status) => store.dispatch({ type: "net", status }),
  onMessage: (msg) => {
    store.dispatch({ type: "server", msg, now: performance.now() });
    if (msg.t === "welcome") {
      conn.setResumeToken(msg.token);
      saveSession({ token: msg.token, playerId: msg.playerId, code: msg.code });
      keepAwake(true);
    } else if (msg.t === "left" || (msg.t === "error" && msg.code === "invalid_token")) {
      conn.setResumeToken(null);
      saveSession(null);
      keepAwake(false);
      if (msg.t === "left") conn.close();
    }
  },
});

const tracker = new GpsTracker(
  (report) => {
    if (store.get().session && conn.isOpen()) conn.send({ t: "location", report });
  },
  (status) => store.dispatch({ type: "gps", status }),
);

export const actions = {
  /** Resume a saved session after a page reload. */
  restore(): void {
    const saved = loadSession();
    if (!saved) return;
    store.dispatch({ type: "server", msg: { t: "welcome", ...saved }, now: performance.now() });
    conn.setResumeToken(saved.token);
    conn.connect();
    tracker.start();
  },
  enableLocation(): void {
    unlockAudio();
    tracker.start();
  },
  create(p: { name: string; role: Role; radiusM: number }): boolean {
    const location = tracker.latestReport();
    if (!location || !canHost(store.get().gps)) return false;
    unlockAudio();
    conn.connect();
    conn.send({ t: "create", name: p.name, role: p.role, radiusM: p.radiusM, consent: true, location });
    return true;
  },
  join(p: { code: string; name: string; role: Role }): void {
    unlockAudio();
    conn.connect();
    conn.send({ t: "join", code: p.code, name: p.name, role: p.role, consent: true });
  },
  ready: (ready: boolean) => conn.send({ t: "ready", ready }),
  configure: (c: { radiusM?: number; captureRadiusM?: number; lockSeconds?: number }) => conn.send({ t: "configure", ...c }),
  confirmSafety: () => conn.send({ t: "confirm_safety" }),
  start: () => conn.send({ t: "start" }),
  pause: () => conn.send({ t: "pause" }),
  resumeMatch: () => conn.send({ t: "resume_match" }),
  end: () => conn.send({ t: "end" }),
  /** Ask the server to remove us; if it can't answer (room already gone), clean up locally. */
  leave(): void {
    conn.send({ t: "leave" });
    setTimeout(() => {
      if (!store.get().session) return;
      conn.setResumeToken(null);
      saveSession(null);
      keepAwake(false);
      conn.close();
      store.dispatch({ type: "reset" });
    }, 900);
  },
  clearError: () => store.dispatch({ type: "clear_error" }),
  expireFx: (id: number) => store.dispatch({ type: "fx_expire", id }),
};
