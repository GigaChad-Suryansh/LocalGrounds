import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Role } from "../../../src/engine";
import { gpsQuality } from "../lib/gps";

/** Orienteering symbols: the start triangle marks killers, the control circle marks survivors. */
export function RoleMark({ role, size = 18 }: { role: Role; size?: number }) {
  return (
    <svg className={`role-mark role-${role}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {role === "killer" ? (
        <path d="M12 3.2 22 20.5H2Z" fill="none" stroke="currentColor" strokeWidth="2.6" />
      ) : (
        <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="2.6" />
      )}
    </svg>
  );
}

export const roleLabel = (r: Role): string => (r === "killer" ? "Killer" : "Survivor");

export function Signal({ bars }: { bars: 0 | 1 | 2 | 3 | 4 }) {
  return (
    <svg className="signal" width="20" height="16" viewBox="0 0 20 16" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={i * 5.2} y={12 - i * 3.6} width="3.6" height={4 + i * 3.6} rx="0.6" className={i < bars ? "on" : ""} />
      ))}
    </svg>
  );
}

/** GPS signal bars with the accuracy radius, e.g. "Good, ±12 m". */
export function GpsChip({ accuracyM, issues = [] }: { accuracyM: number | null; issues?: readonly string[] }) {
  const q = gpsQuality(accuracyM, issues);
  return (
    <span className={`gps-chip q-${q.level}`}>
      <Signal bars={q.bars} />
      <span>
        {q.label}
        {accuracyM !== null && q.level !== "none" ? `, ±${Math.round(accuracyM)} m` : ""}
      </span>
    </span>
  );
}

export interface SegOption<T> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export function Seg<T extends string | number>(props: {
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          className={o.value === props.value ? "on" : ""}
          disabled={props.disabled || o.disabled}
          onClick={() => props.onChange(o.value)}
        >
          <span>{o.label}</span>
          {o.hint ? <small>{o.hint}</small> : null}
        </button>
      ))}
    </div>
  );
}

/** Two-tap guard for destructive actions: the first tap arms the button for a few seconds. */
export function useArmed(ms = 3500): [boolean, () => boolean] {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const press = (): boolean => {
    if (armed) {
      setArmed(false);
      return true;
    }
    setArmed(true);
    timer.current = setTimeout(() => setArmed(false), ms);
    return false;
  };
  return [armed, press];
}

export function Check({ children, checked, onChange, disabled }: {
  children: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`check${disabled ? " is-disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="box" aria-hidden="true" />
      <span className="text">{children}</span>
    </label>
  );
}
