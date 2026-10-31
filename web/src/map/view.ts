import type { ViewerSnapshot } from "../../../src/engine";
import type { MapPlayer, MapView } from "./mapController";

/**
 * Everything the map draws comes from the viewer's snapshot, so the map can only ever show
 * what the server decided this player may see.
 */
export function buildMapView(snap: ViewerSnapshot): MapView {
  const players: MapPlayer[] = [];
  const me = snap.self;
  if (me.position)
    players.push({
      id: me.id,
      name: me.name,
      kind: "self",
      role: me.role,
      lat: me.position.lat,
      lng: me.position.lng,
      accuracyM: me.position.accuracyM,
    });
  for (const o of snap.others) {
    if (!o.position || o.status !== "active") continue;
    players.push({
      id: o.id,
      name: o.name,
      kind: o.role === me.role ? "mate" : "enemy",
      role: o.role,
      lat: o.position.lat,
      lng: o.position.lng,
      accuracyM: o.position.accuracyM,
    });
  }
  return {
    outer: snap.outer,
    // Before the match starts the whole arena is the safe zone.
    safe: snap.zone?.safeZone ?? snap.outer,
    next: snap.zone?.nextSafeZone ?? null,
    warning: snap.zone?.warningActive ?? false,
    players,
  };
}
