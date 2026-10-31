import type { SoundName } from "../lib/fx";

const KEY = "lg.muted";
let ctx: AudioContext | null = null;
let muted = false;

try {
  muted = localStorage.getItem(KEY) === "1";
} catch {
  /* storage unavailable: default to sound on */
}

export const isMuted = (): boolean => muted;

export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem(KEY, m ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Browsers only allow audio after a tap, so call this from a click handler. */
export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
  } catch {
    ctx = null;
  }
}

interface Note {
  f: number;
  at: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  to?: number;
}

const PATTERNS: Record<SoundName, Note[]> = {
  start: [
    { f: 392, at: 0, dur: 0.12, type: "triangle" },
    { f: 523, at: 0.13, dur: 0.12, type: "triangle" },
    { f: 784, at: 0.26, dur: 0.3, type: "triangle" },
  ],
  warn: [
    { f: 540, at: 0, dur: 0.14, type: "square", gain: 0.5 },
    { f: 540, at: 0.22, dur: 0.14, type: "square", gain: 0.5 },
  ],
  shrink: [{ f: 640, at: 0, dur: 0.5, type: "sawtooth", gain: 0.5, to: 160 }],
  scan: [
    { f: 1320, at: 0, dur: 0.5, type: "sine", to: 660 },
    { f: 1320, at: 0.55, dur: 0.5, type: "sine", gain: 0.5, to: 660 },
  ],
  caught: [
    { f: 180, at: 0, dur: 0.45, type: "sawtooth", to: 70 },
    { f: 120, at: 0.05, dur: 0.45, type: "square", gain: 0.5, to: 50 },
  ],
  tag: [
    { f: 880, at: 0, dur: 0.1, type: "triangle" },
    { f: 1320, at: 0.1, dur: 0.22, type: "triangle" },
  ],
  alarm: [
    { f: 330, at: 0, dur: 0.16, type: "square", gain: 0.5 },
    { f: 260, at: 0.2, dur: 0.16, type: "square", gain: 0.5 },
    { f: 330, at: 0.4, dur: 0.16, type: "square", gain: 0.5 },
  ],
  clear: [
    { f: 660, at: 0, dur: 0.1, type: "triangle" },
    { f: 990, at: 0.1, dur: 0.18, type: "triangle" },
  ],
  blip: [{ f: 760, at: 0, dur: 0.07, type: "sine", gain: 0.6 }],
  win: [523, 659, 784, 1047].map((f, i) => ({ f, at: i * 0.12, dur: 0.22, type: "triangle" as const })),
  lose: [392, 330, 262, 196].map((f, i) => ({ f, at: i * 0.16, dur: 0.28, type: "sawtooth" as const, gain: 0.5 })),
};

export function play(name: SoundName): void {
  if (muted || !ctx) return;
  const c = ctx;
  const t0 = c.currentTime + 0.01;
  for (const n of PATTERNS[name]) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = n.type ?? "sine";
    osc.frequency.setValueAtTime(n.f, t0 + n.at);
    if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, t0 + n.at + n.dur);
    const peak = 0.16 * (n.gain ?? 1);
    g.gain.setValueAtTime(0.0001, t0 + n.at);
    g.gain.exponentialRampToValueAtTime(peak, t0 + n.at + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0 + n.at);
    osc.stop(t0 + n.at + n.dur + 0.02);
  }
}

export function vibrate(pattern: number[]): void {
  if (muted) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
}
