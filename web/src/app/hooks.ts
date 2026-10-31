import { useEffect, useState, useSyncExternalStore } from "react";
import { store } from "./runtime";
import type { ClientState } from "../state/store";

export const useGame = (): ClientState => useSyncExternalStore(store.subscribe, store.get);

/** A clock (performance.now) that re-renders the caller a few times a second, for countdowns. */
export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** localStorage-backed string state that never throws (private windows, blocked storage). */
export function useStoredString(key: string, initial = ""): [string, (v: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = (v: string) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      /* ignore */
    }
  };
  return [value, set];
}
