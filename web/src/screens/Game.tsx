import { useMemo, useState } from "react";
import type { ViewerSnapshot } from "../../../src/engine";
import type { RoomInfo } from "../../../src/server/protocol";
import { useGame, useNow } from "../app/hooks";
import { actions } from "../app/runtime";
import { isMuted, setMuted } from "../device/sound";
import { ArenaMap } from "../components/ArenaMap";
import { Check, GpsChip, RoleMark, roleLabel, useArmed } from "../components/ui";
import { lockView, type LockView } from "../lib/lock";
import { standing } from "../lib/standing";
import { formatClock, progress, remainingMs } from "../lib/time";
import { buildMapView } from "../map/view";

interface Props {
  snapshot: ViewerSnapshot;
  room: RoomInfo;
  receivedAt: number;
}

function Menu(props: {
  isHost: boolean;
  paused: boolean;
  follow: boolean;
  onFollow: (v: boolean) => void;
  onFit: () => void;
  onClose: () => void;
}) {
  const [muted, setMutedState] = useState(isMuted());
  const [leaveArmed, pressLeave] = useArmed();
  const [endArmed, pressEnd] = useArmed();
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Menu" onClick={props.onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <h2 className="h-sm">Menu</h2>
        {props.paused ? (
          props.isHost ? (
            <button className="btn primary" onClick={() => { actions.resumeMatch(); props.onClose(); }}>Resume the match</button>
          ) : (
            <p className="help">The match is paused. The host resumes it.</p>
          )
        ) : (
          <button className="btn danger" onClick={() => { actions.pause(); props.onClose(); }}>
            Pause the match for everyone
          </button>
        )}
        <button className="btn" onClick={() => { props.onFit(); props.onClose(); }}>Show the whole arena</button>
        <Check checked={props.follow} onChange={props.onFollow}>Keep the map on my position</Check>
        <Check checked={!muted} onChange={(on) => { setMuted(!on); setMutedState(!on); }}>Sound and vibration</Check>
        <div className="rule" />
        <button className={`btn quiet${leaveArmed ? " armed" : ""}`} onClick={() => pressLeave() && actions.leave()}>
          {leaveArmed ? "Tap again to leave the match" : "Leave the match"}
        </button>
        {props.isHost && (
          <button className={`btn quiet${endArmed ? " armed" : ""}`} onClick={() => pressEnd() && actions.end()}>
            {endArmed ? "Tap again to end it for everyone" : "End the match for everyone"}
          </button>
        )}
        <button className="btn" onClick={props.onClose}>Close</button>
      </div>
    </div>
  );
}

/** Radar Lock progress. Killers see their target; a locked survivor sees only that a lock is closing. */
function LockCard({ lock }: { lock: LockView }) {
  const secs = Math.ceil(lock.remainingMs / 1000);
  const killer = lock.side === "killer";
  return (
    <div className={`alert lock ${killer ? "is-killer" : "is-survivor"}`} role={killer ? "status" : "alert"}>
      <div className="lock-text">
        <strong>{killer ? "Target detected" : "Radar lock detected"}</strong>
        <span>
          {lock.paused
            ? "Waiting for a good GPS signal"
            : killer
              ? `${lock.targetName ?? "Survivor"}: stay in range`
              : "Get out of range to break it"}
        </span>
      </div>
      <span className="clock" aria-label={`${Math.round(lock.progress * 100)} percent`}>{lock.paused ? "..." : `${secs}s`}</span>
      <div className="lockbar" aria-hidden="true"><i style={{ transform: `scaleX(${lock.progress})` }} /></div>
    </div>
  );
}

export function Game({ snapshot, room, receivedAt }: Props) {
  const { gps } = useGame();
  const now = useNow();
  const [menuOpen, setMenuOpen] = useState(false);
  const [follow, setFollow] = useState(false);
  const [fitNonce, setFitNonce] = useState(0);

  const view = useMemo(() => buildMapView(snapshot), [snapshot]);
  const me = snapshot.self;
  const zone = snapshot.zone;
  const reveal = snapshot.reveal;
  const paused = snapshot.matchPhase === "paused";
  const out = me.status !== "active";
  const isHost = room.hostId === me.id;
  const since = paused ? receivedAt : now; // countdowns freeze while paused

  const everyone = [me, ...snapshot.others];
  const alive = (role: "killer" | "survivor") => everyone.filter((p) => p.role === role && p.status === "active").length;
  const noun = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  let zoneLabel = "Zone closes";
  let zoneMs: number | null = null;
  if (zone) {
    if (zone.msUntilNextPhase !== null) zoneMs = remainingMs(zone.msUntilNextPhase, receivedAt, since);
    else {
      zoneLabel = "Match ends";
      zoneMs = remainingMs(zone.msUntilEnd, receivedAt, since);
    }
  }

  let scanLabel = "Next scan";
  let scanMs = 0;
  let scanFill = 0;
  if (reveal) {
    if (reveal.active && reveal.msRemaining !== null) {
      scanLabel = "Scan active";
      scanMs = remainingMs(reveal.msRemaining, receivedAt, since);
      scanFill = progress(scanMs, room.revealDurationMs);
    } else {
      scanMs = remainingMs(reveal.msUntilNext, receivedAt, since);
      scanFill = 1 - progress(scanMs, room.revealIntervalMs);
    }
  }

  const where = standing(me.position, snapshot.outer, zone?.safeZone ?? null);
  const grace = me.redZone.graceRemainingMs === null ? null : remainingMs(me.redZone.graceRemainingMs, receivedAt, since);
  const danger = me.redZone.status === "warning" || me.redZone.status === "penalized";
  const gpsOff = gps.state !== "active" && gps.state !== "requesting";
  const gpsWeak = me.locationIssues.length > 0;
  const lock = lockView(snapshot, receivedAt, now, paused);

  return (
    <main className={`game${paused ? " is-paused" : ""}`}>
      <ArenaMap view={view} follow={follow} fitNonce={fitNonce} />
      {reveal?.active && <div className="radar" aria-hidden="true" />}
      <div className={`edge${danger ? " danger" : zone?.warningActive ? " warn" : ""}`} aria-hidden="true" />

      <header className="hud">
        <div className="hud-card who">
          <RoleMark role={me.role} size={24} />
          <div>
            <strong>{roleLabel(me.role)}</strong>
            <span>{noun(alive("killer"), "killer")}, {noun(alive("survivor"), "survivor")} left</span>
          </div>
        </div>
        <button className="hud-menu" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="2.6" fill="none" /></svg>
        </button>
        <div className="hud-row">
          <div className={`hud-card zone${zone?.warningActive ? " is-warning" : ""}`}>
            <span className="k">{zoneLabel}</span>
            <strong className="clock">{zoneMs === null ? "-" : formatClock(zoneMs)}</strong>
            {zone && <span className="n">{zone.nextSafeZone ? `Zone ${zone.phaseIndex + 1}` : "Final zone"}</span>}
          </div>
          <div className={`hud-card scan${reveal?.active ? " is-active" : ""}`}>
            <span className="k">{scanLabel}</span>
            <strong className="clock">{formatClock(scanMs)}</strong>
            <div className="bar"><i style={{ transform: `scaleX(${scanFill})` }} /></div>
          </div>
        </div>
      </header>

      <div className="alerts">
        {lock && <LockCard lock={lock} />}
        {me.redZone.status === "warning" && grace !== null && (
          <div className="alert danger" role="alert">
            <strong>Return to the safe zone</strong>
            <span className="clock">{formatClock(grace)}</span>
          </div>
        )}
        {me.redZone.status === "penalized" && (
          <div className="alert danger" role="alert">
            <strong>Taking damage. Get inside the safe zone.</strong>
            <div className="hp" aria-label={`Health ${Math.round(me.redZone.hp)} of 100`}><i style={{ transform: `scaleX(${me.redZone.hp / 100})` }} /></div>
          </div>
        )}
        {gpsOff ? (
          <div className="alert warn" role="alert">
            <strong>Location is off, so the game can't see you.</strong>
            <button className="btn small" onClick={actions.enableLocation}>Turn on</button>
          </div>
        ) : gpsWeak ? (
          <div className="alert warn" role="status">
            <strong>Weak GPS signal. Move to open sky so the game can see you.</strong>
          </div>
        ) : null}
      </div>

      <footer className="dock">
        <div className="hud-card status">
          <GpsChip accuracyM={me.position?.accuracyM ?? null} issues={me.locationIssues} />
          {where && <span className={`where tone-${where.tone}`}>{where.text}</span>}
        </div>
      </footer>

      {out && !paused && (
        <section className="out" role="status">
          <h2>{me.status === "captured" ? "You were caught" : me.status === "eliminated" ? "You're eliminated" : "You're out"}</h2>
          <p>You can't see the map any more, but the match goes on. {alive("survivor")} survivors and {alive("killer")} killers are still in.</p>
          <button className="btn" onClick={actions.leave}>Leave the match</button>
        </section>
      )}

      {paused && (
        <section className="paused" role="alertdialog" aria-label="Match paused">
          <h2>Match paused</h2>
          <p>Stay where you are and stay safe. The clock and every penalty are stopped.</p>
          {isHost ? (
            <button className="btn primary" onClick={actions.resumeMatch}>Resume the match</button>
          ) : (
            <p className="help">The host resumes the match.</p>
          )}
          <button className="btn quiet" onClick={() => setMenuOpen(true)}>Menu</button>
        </section>
      )}

      {menuOpen && (
        <Menu
          isHost={isHost}
          paused={paused}
          follow={follow}
          onFollow={setFollow}
          onFit={() => setFitNonce((n) => n + 1)}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </main>
  );
}
