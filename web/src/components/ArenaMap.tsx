import { useEffect, useRef } from "react";
import { MapController, type MapView } from "../map/mapController";

interface Props {
  view: MapView;
  follow?: boolean;
  /** Increment to re-frame the whole arena. */
  fitNonce?: number;
}

export function ArenaMap({ view, follow = false, fitNonce = 0 }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const ctl = useRef<MapController | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const c = new MapController(el);
    ctl.current = c;
    const ro = new ResizeObserver(() => c.invalidateSize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      c.destroy();
      ctl.current = null;
    };
  }, []);

  useEffect(() => ctl.current?.update(view), [view]);
  useEffect(() => ctl.current?.setFollow(follow), [follow]);
  useEffect(() => {
    if (fitNonce > 0) ctl.current?.fit();
  }, [fitNonce]);

  return <div ref={host} className="map" role="img" aria-label="Map of the arena" />;
}
