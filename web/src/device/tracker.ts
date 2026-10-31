import type { LocationReport } from "../../../src/shared/types";
import { fixTimestamp, gpsErrorState, planTick, toReport, type GpsStatus, type PositionLike } from "../lib/gps";

const OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 };

/**
 * Watches the device position and forwards the latest fix about once a second. Stationary phones
 * often stop emitting watch updates, which the server would read as a stale signal, so a quiet
 * watch is topped up with explicit fresh fixes and, failing those, a short-lived heartbeat that
 * re-confirms the last position (see `planTick`).
 */
export class GpsTracker {
  private watchId: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: PositionLike | null = null;
  private lastReceivedAt = 0;
  private lastSentTimestamp = 0;
  private polling = false;

  constructor(
    private readonly onReport: (r: LocationReport) => void,
    private readonly onStatus: (s: GpsStatus) => void,
    private readonly intervalMs = 1000,
  ) {}

  get running(): boolean {
    return this.watchId !== null;
  }

  /** The newest fix as a report (age measured now), or null if there hasn't been one. */
  latestReport(): LocationReport | null {
    return this.latest ? toReport(this.latest, Date.now()) : null;
  }

  start(): void {
    if (this.running) return;
    if (!("geolocation" in navigator)) {
      this.onStatus({ state: "unavailable" });
      return;
    }
    this.onStatus({ state: "requesting" });
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.accept(p),
      (e) => this.fail(e.code),
      OPTIONS,
    );
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    if (this.timer) clearInterval(this.timer);
    this.watchId = null;
    this.timer = null;
    this.latest = null;
    this.lastSentTimestamp = 0;
    this.onStatus({ state: "off" });
  }

  /** `requestedAt` is set for explicit fixes (made with maximumAge 0), see `fixTimestamp`. */
  private accept(p: GeolocationPosition, requestedAt = 0): void {
    this.latest = {
      coords: { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy },
      timestamp: fixTimestamp(p.timestamp, requestedAt),
    };
    this.lastReceivedAt = Date.now();
    this.onStatus({ state: "active", accuracyM: p.coords.accuracy, at: this.lastReceivedAt });
  }

  private fail(code: number): void {
    const status = gpsErrorState(code);
    // A denied permission can't recover by itself; stop so the UI can offer a retry.
    if (status.state === "denied") this.stop();
    this.onStatus(status);
  }

  private tick(): void {
    const now = Date.now();
    const plan = planTick({
      hasFix: this.latest !== null,
      fixTimestamp: this.latest?.timestamp ?? 0,
      lastSentTimestamp: this.lastSentTimestamp,
      lastReceivedAt: this.lastReceivedAt,
      now,
    });
    if (this.latest && plan.send === "fix") {
      this.lastSentTimestamp = this.latest.timestamp;
      this.onReport(toReport(this.latest, now));
    } else if (this.latest && plan.send === "heartbeat") {
      this.onReport(toReport({ coords: this.latest.coords, timestamp: now }, now));
    }
    if (plan.poll && !this.polling) {
      this.polling = true;
      const requestedAt = now;
      navigator.geolocation.getCurrentPosition(
        (p) => {
          this.polling = false;
          this.accept(p, requestedAt);
        },
        () => {
          this.polling = false;
        },
        { ...OPTIONS, timeout: 8000 },
      );
    }
  }
}
