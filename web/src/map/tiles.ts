/**
 * Which map tiles to draw. Satellite imagery by default (Esri World Imagery, free to use with
 * attribution), with place and road labels on top. Everything can be changed at build time:
 *
 *   VITE_TILE_STYLE        "satellite" (default) | "streets"
 *   VITE_TILE_URL          your own XYZ template, e.g. https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}
 *   VITE_TILE_KEY          substituted for {key} in VITE_TILE_URL
 *   VITE_TILE_ATTRIBUTION  attribution text/HTML your provider requires
 *   VITE_TILE_LABELS       "off" to hide the label overlay
 *
 * Remember to allow a custom tile host in the server's CSP with EXTRA_IMG_SRC.
 */
export interface TileSpec {
  kind: "satellite" | "streets";
  url: string;
  attribution: string;
  maxNativeZoom: number;
  /** Place/road label overlay drawn above the imagery, if any. */
  labelsUrl: string | null;
}

export type TileEnv = Partial<Record<
  "VITE_TILE_STYLE" | "VITE_TILE_URL" | "VITE_TILE_KEY" | "VITE_TILE_ATTRIBUTION" | "VITE_TILE_LABELS",
  string
>>;

const ESRI_IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ESRI_LABELS =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
const ESRI_ATTRIBUTION =
  'Tiles &copy; <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community';
const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export function tileSpec(env: TileEnv = {}): TileSpec {
  const labels = env.VITE_TILE_LABELS !== "off";
  if (env.VITE_TILE_URL) {
    const url = env.VITE_TILE_URL.replace("{key}", encodeURIComponent(env.VITE_TILE_KEY ?? ""));
    return {
      kind: env.VITE_TILE_STYLE === "streets" ? "streets" : "satellite",
      url,
      attribution: env.VITE_TILE_ATTRIBUTION ?? "",
      maxNativeZoom: 19,
      labelsUrl: null,
    };
  }
  if (env.VITE_TILE_STYLE === "streets")
    return { kind: "streets", url: OSM, attribution: OSM_ATTRIBUTION, maxNativeZoom: 19, labelsUrl: null };
  return {
    kind: "satellite",
    url: ESRI_IMAGERY,
    attribution: ESRI_ATTRIBUTION,
    maxNativeZoom: 19,
    labelsUrl: labels ? ESRI_LABELS : null,
  };
}
