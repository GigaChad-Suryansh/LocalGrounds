import { useMemo, useState } from "react";
import type { ViewerSnapshot } from "../../../src/engine";
import type { RoomInfo } from "../../../src/server/protocol";
import type { StartBlocker, EligibilityIssue, StartEvaluation } from "../../../src/engine";
import { actions } from "../app/runtime";
import { ArenaMap } from "../components/ArenaMap";
import { Check, GpsChip, RoleMark, roleLabel, Seg, useArmed } from "../components/ui";
import { buildMapView } from "../map/view";

const BLOCKERS: Record<StartBlocker, string> = {
  safety_not_confirmed: "Confirm the area is safe.",
  not_enough_killers: "Needs at least one killer.",
  not_enough_survivors: "Needs at least one survivor.",
  players_not_ready: "Waiting for everyone to get ready.",
  players_ineligible: "Some players need a better GPS fix inside the arena.",
};

const ISSUES: Record<EligibilityIssue, string> = {
  no_location: "no GPS yet",
  stale_location: "GPS signal is stale",
  inaccurate_location: "GPS is weak",
  outside_start_area: "outside the arena",
};

const CAPTURE_RADII = [10, 15, 25, 35, 50];

function useCopy(text: string): [boolean, () => void] {
  const [done, setDone] = useState(false);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      })
      .catch(() => undefined);
  };
  return [done, copy];
}

interface Props {
  snapshot: ViewerSnapshot;
  room: RoomInfo;
  startCheck: StartEvaluation | null;
}

export function Lobby({ snapshot, room, startCheck }: Props) {
  const me = snapshot.self;
  const isHost = room.hostId === me.id;
  const view = useMemo(() => buildMapView(snapshot), [snapshot]);
  const [fitNonce, setFitNonce] = useState(0);
  const [codeCopied, copyCode] = useCopy(room.code);
  const [linkCopied, copyLink] = useCopy(`${location.origin}/?code=${room.code}`);
  const [leaveArmed, pressLeave] = useArmed();

  const roster = [me, ...snapshot.others].filter((p) => p.status !== "left");
  const nameOf = (id: string) => roster.find((p) => p.id === id)?.name ?? "A player";
  const myIssues = me.eligibility.issues;

  return (
    <main className="lobby">
      <section className="lobby-map" aria-label="Arena preview">
        <ArenaMap view={view} fitNonce={fitNonce} />
        <div className="map-caption">
          <span>
            <strong>{snapshot.outer.radiusM} m</strong> radius
          </span>
          <button type="button" className="btn small" onClick={() => setFitNonce((n) => n + 1)}>
            Show arena
          </button>
        </div>
      </section>

      <section className="lobby-panel">
        <div className="room-code">
          <div>
            <span className="label">Room code</span>
            <strong className="code" aria-label={`Room code ${room.code.split("").join(" ")}`}>{room.code}</strong>
          </div>
          <div className="row">
            <button type="button" className="btn small" onClick={copyCode}>{codeCopied ? "Copied" : "Copy code"}</button>
            <button type="button" className="btn small" onClick={copyLink}>{linkCopied ? "Copied" : "Copy link"}</button>
          </div>
        </div>

        <div className="rule" />

        <div className="you">
          <RoleMark role={me.role} size={22} />
          <div>
            <strong>{me.name}</strong>
            <span>{roleLabel(me.role)}{isHost ? ", host" : ""}</span>
          </div>
          <GpsChip accuracyM={me.position?.accuracyM ?? null} issues={me.locationIssues} />
        </div>
        {myIssues.length > 0 && (
          <p className="help warn" role="status">
            {myIssues.map((i) => ISSUES[i]).join(", ")}. {myIssues.includes("outside_start_area") ? "Walk into the circle on the map." : "Move to open sky."}
          </p>
        )}
        <p className="help">Keep this screen on and open during the match. Tracking pauses when the screen sleeps.</p>

        <div className="rule" />

        <h2 className="h-sm">Players ({roster.length})</h2>
        <ul className="roster">
          {roster.map((p) => {
            const self = p.id === me.id;
            const ready = p.ready;
            const issues = startCheck?.players.find((x) => x.playerId === p.id)?.issues ?? [];
            return (
              <li key={p.id}>
                <RoleMark role={p.role} />
                <span className="who">
                  {self ? `${p.name} (you)` : p.name}
                  {p.id === room.hostId ? <em>host</em> : null}
                  {!self && issues.length > 0 ? <small>{issues.map((i) => ISSUES[i]).join(", ")}</small> : null}
                </span>
                <span className={`ready${ready ? " yes" : ""}`}>{ready ? "Ready" : "Not ready"}</span>
              </li>
            );
          })}
        </ul>

        {isHost && (
          <>
            <div className="rule" />
            <h2 className="h-sm">Arena</h2>
            <Seg
              label="Arena radius"
              value={snapshot.outer.radiusM}
              onChange={(radiusM) => actions.configure({ radiusM })}
              options={room.radiusPresetsM.map((r) => ({ value: r, label: `${r} m` }))}
            />
            <span className="label">Tag distance</span>
            <Seg
              label="Tag distance"
              value={room.captureRadiusM}
              onChange={(captureRadiusM) => actions.configure({ captureRadiusM })}
              options={CAPTURE_RADII.map((r) => ({ value: r, label: `${r} m` }))}
            />
            <Check checked={snapshot.safetyConfirmed} disabled={snapshot.safetyConfirmed} onChange={() => actions.confirmSafety()}>
              I've checked that this area is open to the public, safe to move around in, and away from roads and water.
            </Check>
          </>
        )}

        <div className="rule" />

        <div className="actions">
          <button
            type="button"
            className={`btn ${me.ready ? "" : "primary"}`}
            disabled={myIssues.length > 0 && !me.ready}
            onClick={() => actions.ready(!me.ready)}
          >
            {me.ready ? "Not ready" : "Ready"}
          </button>
          {isHost && (
            <button type="button" className="btn primary go" disabled={!startCheck?.canStart} onClick={actions.start}>
              Start match
            </button>
          )}
          <button type="button" className={`btn quiet${leaveArmed ? " armed" : ""}`} onClick={() => pressLeave() && actions.leave()}>
            {leaveArmed ? "Tap again to leave" : "Leave room"}
          </button>
        </div>

        {isHost && startCheck && !startCheck.canStart && (
          <ul className="blockers" aria-label="Why the match can't start yet">
            {startCheck.blockers.map((b) => (
              <li key={b}>{BLOCKERS[b]}</li>
            ))}
            {startCheck.players
              .filter((p) => p.issues.length > 0 && p.playerId !== me.id)
              .map((p) => (
                <li key={p.playerId}>
                  {nameOf(p.playerId)}: {p.issues.map((i) => ISSUES[i]).join(", ")}.
                </li>
              ))}
          </ul>
        )}
        {!isHost && <p className="help">Waiting for {nameOf(room.hostId)} to start the match.</p>}
      </section>
    </main>
  );
}
