import L from "leaflet";
import { tileSpec, type TileEnv } from "./tiles";
import "leaflet/dist/leaflet.css";
import type { Role } from "../../../src/engine";
import type { Circle } from "../../../src/shared/types";
import { circleRing, easeOutCubic, lerp, WORLD_RING } from "./geometry";

export type PinKind = "self" | "mate" | "enemy";

export interface MapPlayer {
  id: string;
  name: string;
  kind: PinKind;
  role: Role;
  lat: number;
  lng: number;
  accuracyM: number;
}

export interface MapView {
  /** The fixed outer boundary. */
  outer: Circle;
  /** Current safe zone; null in the lobby (only the boundary is drawn). */
  safe: Circle | null;
  /** The zone that takes effect next, if any. */
  next: Circle | null;
  /** True while the next shrink is about to happen. */
  warning: boolean;
  players: MapPlayer[];
}

interface Pin {
  marker: L.Marker;
  el: HTMLElement;
  label: HTMLElement;
  accuracy: L.Circle | null;
}

const SHRINK_MS = 2600;

/** Owns the Leaflet map. React hands it a `MapView` on every snapshot; it diffs and animates. */
export class MapController {
  private readonly map: L.Map;
  private mask: L.Polygon | null = null;
  private outer: L.Circle | null = null;
  private red: L.Polygon | null = null;
  private safe: L.Circle | null = null;
  private next: L.Circle | null = null;
  private readonly pins = new Map<string, Pin>();

  private outerKey = "";
  private outerCircle: Circle | null = null;
  private drawnRadius: number | null = null;
  private targetRadius: number | null = null;
  private anim: number | null = null;
  private follow = false;
  private readonly reduceMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(el: HTMLElement) {
    this.map = L.map(el, { zoomControl: false, maxZoom: 20, minZoom: 3, attributionControl: true });
    const tiles = tileSpec(import.meta.env as TileEnv);
    el.classList.add(`tiles-${tiles.kind}`);
    L.tileLayer(tiles.url, { maxNativeZoom: tiles.maxNativeZoom, maxZoom: 20, attribution: tiles.attribution }).addTo(this.map);
    if (tiles.labelsUrl)
      L.tileLayer(tiles.labelsUrl, { maxNativeZoom: 17, maxZoom: 20, className: "lg-labels" }).addTo(this.map);
    L.control.zoom({ position: "bottomright" }).addTo(this.map);
    this.map.setView([20, 0], 3);
  }

  setFollow(on: boolean): void {
    this.follow = on;
  }

  invalidateSize(): void {
    this.map.invalidateSize();
  }

  /** Frame the whole arena. Called on first draw and from the "show arena" button. */
  fit(): void {
    if (!this.outer) return;
    this.map.invalidateSize();
    this.map.fitBounds(this.outer.getBounds(), { padding: [28, 28], animate: false });
  }

  update(v: MapView): void {
    const key = `${v.outer.center.lat},${v.outer.center.lng},${v.outer.radiusM}`;
    if (key !== this.outerKey) {
      this.drawOuter(v.outer);
      this.outerKey = key;
      this.fit();
    }
    this.drawZones(v);
    this.drawPlayers(v.players);
    if (this.follow) {
      const me = v.players.find((p) => p.kind === "self");
      if (me) this.map.panTo([me.lat, me.lng], { animate: true });
    }
  }

  destroy(): void {
    if (this.anim !== null) cancelAnimationFrame(this.anim);
    this.map.remove();
  }

  // ---------------------------------------------------------------- arena

  private drawOuter(o: Circle): void {
    for (const l of [this.mask, this.outer, this.red, this.safe, this.next]) l?.remove();
    this.red = this.safe = this.next = null;
    this.drawnRadius = this.targetRadius = null;
    this.outerCircle = o;

    // Everything outside the arena is dimmed and hatched.
    this.mask = L.polygon([WORLD_RING, circleRing(o)], {
      stroke: false,
      fillOpacity: 1,
      interactive: false,
      className: "lg-mask",
    }).addTo(this.map);
    this.outer = L.circle([o.center.lat, o.center.lng], {
      radius: o.radiusM,
      fill: false,
      weight: 3,
      interactive: false,
      className: "lg-outer",
    }).addTo(this.map);
    this.ensurePatterns(this.mask);
  }

  private patterns = false;

  /** Hatching for out-of-bounds (olive stripes) and the red zone (hazard stripes), themed by CSS. */
  private ensurePatterns(layer: L.Path): void {
    if (this.patterns) return;
    const svg = (layer.getElement() as SVGElement | undefined)?.ownerSVGElement;
    if (!svg) return;
    svg.insertAdjacentHTML(
      "afterbegin",
      `<defs>
        <pattern id="lg-olive" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(90)">
          <rect width="8" height="8" class="pat-olive-bg"/><rect width="3" height="8" class="pat-olive"/>
        </pattern>
        <pattern id="lg-hazard" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="10" height="10" class="pat-hazard-bg"/><rect width="3.4" height="10" class="pat-hazard"/>
        </pattern>
      </defs>`,
    );
    this.patterns = true;
  }

  private drawZones(v: MapView): void {
    const o = v.outer;
    if (!v.safe) {
      for (const l of [this.red, this.safe, this.next]) l?.remove();
      this.red = this.safe = this.next = null;
      this.drawnRadius = this.targetRadius = null;
      return;
    }

    if (this.targetRadius !== v.safe.radiusM) {
      const first = this.drawnRadius === null;
      this.targetRadius = v.safe.radiusM;
      if (first || this.reduceMotion) this.renderSafe(o, v.safe.radiusM);
      else this.animateSafe(o, v.safe.radiusM);
    }

    if (v.next) {
      const ll: L.LatLngExpression = [v.next.center.lat, v.next.center.lng];
      if (!this.next)
        this.next = L.circle(ll, { radius: v.next.radiusM, fill: false, weight: 2, interactive: false, className: "lg-next" }).addTo(this.map);
      else this.next.setLatLng(ll).setRadius(v.next.radiusM);
      this.next.getElement()?.classList.toggle("is-warning", v.warning);
    } else if (this.next) {
      this.next.remove();
      this.next = null;
    }
  }

  private renderSafe(o: Circle, radius: number): void {
    this.drawnRadius = radius;
    const center: L.LatLngExpression = [o.center.lat, o.center.lng];
    if (!this.safe)
      this.safe = L.circle(center, { radius, fill: false, weight: 3, interactive: false, className: "lg-safe" }).addTo(this.map);
    else this.safe.setRadius(radius);

    // The red zone is the ring between the safe circle and the fixed outer boundary.
    if (radius >= o.radiusM - 0.5) {
      this.red?.remove();
      this.red = null;
    } else {
      const rings = [circleRing(o), circleRing({ center: o.center, radiusM: radius })];
      if (!this.red)
        this.red = L.polygon(rings, { stroke: false, fillOpacity: 1, interactive: false, className: "lg-red" }).addTo(this.map);
      else this.red.setLatLngs(rings);
      this.safe.bringToFront();
    }
  }

  private animateSafe(o: Circle, to: number): void {
    if (this.anim !== null) cancelAnimationFrame(this.anim);
    const from = this.drawnRadius ?? to;
    const t0 = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / SHRINK_MS);
      this.renderSafe(o, lerp(from, to, easeOutCubic(t)));
      this.anim = t < 1 ? requestAnimationFrame(step) : null;
    };
    this.anim = requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- players

  private drawPlayers(players: MapPlayer[]): void {
    const seen = new Set<string>();
    for (const p of players) {
      seen.add(p.id);
      const ll: L.LatLngExpression = [p.lat, p.lng];
      let pin = this.pins.get(p.id);
      if (!pin) {
        pin = this.createPin(p);
        this.pins.set(p.id, pin);
      }
      pin.marker.setLatLng(ll);
      pin.el.className = `lg-pin is-${p.kind} role-${p.role}`;
      pin.label.textContent = p.kind === "self" ? "You" : p.name;
      if (p.kind === "self") {
        if (!pin.accuracy)
          pin.accuracy = L.circle(ll, { radius: p.accuracyM, weight: 1, interactive: false, className: "lg-accuracy" }).addTo(this.map);
        else pin.accuracy.setLatLng(ll).setRadius(p.accuracyM);
      }
    }
    for (const [id, pin] of this.pins) {
      if (seen.has(id)) continue;
      pin.marker.remove();
      pin.accuracy?.remove();
      this.pins.delete(id);
    }
  }

  private createPin(p: MapPlayer): Pin {
    const el = document.createElement("div");
    const ring = document.createElement("span");
    ring.className = "ring";
    const dot = document.createElement("span");
    dot.className = "dot";
    const label = document.createElement("span");
    label.className = "label";
    el.append(ring, dot, label);
    const marker = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ html: el, className: "lg-icon", iconSize: [0, 0] }),
      interactive: false,
      keyboard: false,
      zIndexOffset: p.kind === "self" ? 1000 : 500,
    }).addTo(this.map);
    return { marker, el, label, accuracy: null };
  }
}
