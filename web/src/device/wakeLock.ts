/** Keeps the screen awake while a match is open (browsers stop sending GPS when the screen sleeps). */
let sentinel: WakeLockSentinel | null = null;
let wanted = false;

async function acquire(): Promise<void> {
  try {
    if (!wanted || sentinel || !("wakeLock" in navigator)) return;
    sentinel = await navigator.wakeLock.request("screen");
    sentinel.addEventListener("release", () => {
      sentinel = null;
    });
  } catch {
    sentinel = null; // denied or unsupported: the UI still warns players to keep the screen on
  }
}

if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void acquire();
  });

export function keepAwake(on: boolean): void {
  wanted = on;
  if (on) void acquire();
  else {
    void sentinel?.release();
    sentinel = null;
  }
}
