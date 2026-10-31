import { useEffect, useRef } from "react";
import { actions } from "../app/runtime";
import { play, vibrate } from "../device/sound";
import type { Fx } from "../lib/fx";

/**
 * Every banner, flash, shake, sound and vibration in the game starts here, from a server event
 * that the reducer already turned into an `Fx`. Nothing animates on its own.
 */
export function FxLayer({ fx }: { fx: Fx[] }) {
  const seen = useRef(new Set<number>());

  useEffect(() => {
    for (const f of fx) {
      if (seen.current.has(f.id)) continue;
      seen.current.add(f.id);
      if (f.sound) play(f.sound);
      if (f.vibrate) vibrate(f.vibrate);
      if (f.shake) {
        document.body.classList.add("shake");
        setTimeout(() => document.body.classList.remove("shake"), 520);
      }
      setTimeout(() => actions.expireFx(f.id), f.durationMs);
    }
  }, [fx]);

  return (
    <div className="fx" aria-live="polite">
      {fx.filter((f) => f.flash).map((f) => (
        <div key={`flash-${f.id}`} className={`flash tone-${f.tone}`} aria-hidden="true" />
      ))}
      <div className="banners">
        {fx.map((f) => (
          <div key={f.id} className={`banner tone-${f.tone} kind-${f.kind}`} style={{ ["--d" as string]: `${f.durationMs}ms` }}>
            <strong>{f.title}</strong>
            {f.subtitle && <span>{f.subtitle}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
