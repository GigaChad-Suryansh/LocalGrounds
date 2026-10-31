/**
 * Plays a whole match through the built web app in real (headless) browsers with emulated GPS.
 *
 *   npm run web:build && npm run ui:smoke
 *
 * One killer and two survivors. It exercises: consent gating, create/join, lobby readiness and the
 * host's safety confirmation, start, emergency pause/resume, the zone warning and shrink, the red
 * zone and elimination, the 120 s-style scan (shortened here), tagging, and the end screens. Every
 * snapshot each browser receives is also checked for hidden-position leaks.
 *
 * Map tiles and web fonts are blocked on purpose (the run is offline-safe), so screenshots show the
 * vector layers on a plain background with fallback fonts.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { destinationPoint } from "../src/geo/distance";
import type { ZonePhaseConfig } from "../src/geo/zones";
import { startServer } from "../src/server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { chromium } = createRequire(import.meta.url)("playwright") as any;
type Page = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const OUT = resolve(process.env.SHOTS_DIR ?? "scripts/out");
mkdirSync(OUT, { recursive: true });

const CENTER = { lat: 28.6139, lng: 77.209 };
const at = (bearing: number, m: number) => destinationPoint(CENTER, bearing, m);

const PHASES: ZonePhaseConfig[] = [
  { radiusFraction: 1, holdSeconds: 20, warningSeconds: 0 },
  { radiusFraction: 0.5, holdSeconds: 45, warningSeconds: 10 },
  { radiusFraction: 0.25, holdSeconds: 40, warningSeconds: 10 },
];

const log = (m: string) => console.log(`  ${m}`);
let failures = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const server = await startServer({
    port: 0,
    host: "127.0.0.1",
    tickMs: 250,
    staticDir: resolve("web/dist"),
    serviceOptions: {
      phases: PHASES,
      gameConfig: {
        reveal: { intervalMs: 20_000, durationMs: 8_000 },
        redZone: { graceSeconds: 6, confirmSamples: 2, penalty: { kind: "eliminate" }, maxStepMs: 10_000 },
      },
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch();

  interface Player { name: string; page: Page; ctx: any; leaks: string[]; frames: number; base: { lat: number; lng: number } } // eslint-disable-line @typescript-eslint/no-explicit-any
  async function newPlayer(name: string, pos: { lat: number; lng: number }): Promise<Player> {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      permissions: ["geolocation"],
      geolocation: { latitude: pos.lat, longitude: pos.lng, accuracy: 8 },
    });
    await ctx.route(/tile\.openstreetmap\.org|fonts\.(googleapis|gstatic)\.com/, (r: any) => r.abort()); // eslint-disable-line @typescript-eslint/no-explicit-any
    const page = await ctx.newPage();
    const player: Player = { name, page, ctx, leaks: [], frames: 0, base: pos };
    page.on("pageerror", (e: Error) => { failures++; console.log(`FAIL  [${name}] page error: ${e.message}`); });
    page.on("websocket", (ws: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
      ws.on("framereceived", (ev: { payload: string }) => {
        player.frames++;
        let m: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        try { m = JSON.parse(ev.payload); } catch { return; }
        if (m.t !== "snapshot") return;
        const s = m.snapshot;
        for (const o of s.others)
          if (o.position && o.role !== s.self.role && !(s.matchPhase === "active" && s.reveal?.active))
            player.leaks.push(`${name} saw ${o.name} at ${JSON.stringify(o.position)} outside a reveal (${s.matchPhase})`);
      }));
    return player;
  }
  const shot = (p: Player, label: string) => p.page.screenshot({ path: join(OUT, `${label}.png`) });
  const emit = (p: Player) => {
    const j = destinationPoint(p.base, Math.random() * 360, Math.random() * 1.5); // real GPS jitters by a metre or two
    return p.ctx.setGeolocation({ latitude: j.lat, longitude: j.lng, accuracy: 8 });
  };
  const move = (p: Player, pos: { lat: number; lng: number }) => {
    p.base = pos;
    return emit(p);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wait = (p: Player, selector: string, timeout = 40_000) => p.page.waitForSelector(selector, { timeout });
  const banner = (p: Player, text: string, timeout = 40_000) =>
    p.page.waitForSelector(`.banner:has-text("${text}")`, { timeout, state: "attached" });

  const kai = await newPlayer("Kai", CENTER);
  const sam = await newPlayer("Sam", at(180, 60));
  const cam = await newPlayer("Cam", at(90, 100));

  const jitter = setInterval(() => { for (const p of [kai, sam, cam]) void emit(p).catch(() => undefined); }, 1200);

  try {
    // ------------------------------------------------------------- landing + create
    console.log("Landing and lobby");
    await kai.page.goto(base);
    await kai.page.fill("#name", "Kai");
    await kai.page.locator(".role-pick button", { hasText: "Killer" }).click();
    const create = kai.page.getByRole("button", { name: "Create room" });
    check(await create.isDisabled(), "Create is disabled until the player consents and location is on");
    await shot(kai, "01-landing");
    await kai.page.locator(".check", { hasText: "I agree to share my live location" }).click();
    await kai.page.getByRole("button", { name: "Turn on location" }).click();
    await wait(kai, ".locate .gps-chip");
    check(await create.isEnabled(), "Create enables once consent is given and a GPS fix arrives");
    await create.click();
    await wait(kai, ".lobby .code");
    const code = (await kai.page.locator(".lobby .code").innerText()).trim();
    check(/^[A-Z0-9]{5}$/.test(code), `Room created with code ${code}`);

    for (const p of [sam, cam]) {
      await p.page.goto(`${base}/?code=${code}`);
      check((await p.page.inputValue("#code")) === code, `${p.name}: the invite link pre-fills the room code`);
      await p.page.fill("#name", p.name);
      await p.page.locator(".check", { hasText: "I agree to share my live location" }).click();
      await p.page.getByRole("button", { name: "Turn on location" }).click();
      await wait(p, ".locate .gps-chip");
      await p.page.getByRole("button", { name: "Join room" }).click();
      await wait(p, ".lobby");
    }
    await kai.page.waitForFunction(() => document.querySelectorAll(".roster li").length === 3);
    const start = kai.page.getByRole("button", { name: "Start match" });
    check(await start.isDisabled(), "Start is blocked before anyone is ready or the area is confirmed");
    await sleep(1500);
    await shot(kai, "02-lobby-host");

    await kai.page.locator(".check", { hasText: "I've checked that this area" }).click();
    for (const p of [kai, sam, cam]) await p.page.getByRole("button", { name: "Ready", exact: true }).click();
    await start.waitFor({ state: "visible" });
    await kai.page.waitForFunction(() => !(document.querySelector(".actions .go") as HTMLButtonElement | null)?.disabled);
    check(await start.isEnabled(), "Start unlocks after the host confirms safety and everyone is ready");
    await shot(sam, "03-lobby-guest");

    // ------------------------------------------------------------- start + pause
    console.log("Match");
    await start.click();
    for (const p of [kai, sam, cam]) await wait(p, ".game");
    await banner(kai, "Match start");
    await shot(kai, "04-start-banner");

    await sam.page.getByLabel("Open menu").click();
    await sam.page.getByRole("button", { name: "Pause the match for everyone" }).click();
    await wait(kai, ".paused");
    check(true, "An emergency pause from a survivor reaches the host");
    await shot(kai, "05-paused");
    await kai.page.locator(".paused").getByRole("button", { name: "Resume the match" }).click();
    await kai.page.waitForSelector(".paused", { state: "detached" });
    check(true, "The host resumes the match");

    // ------------------------------------------------------------- zone warning, shrink, scan, red zone
    await banner(kai, "Zone closing");
    check((await kai.page.locator(".hud-card.zone.is-warning").count()) === 1, "The zone card flashes during the warning");
    await sleep(600);
    await shot(kai, "06-zone-warning");

    check((await kai.page.locator(".lg-pin.is-enemy").count()) === 0, "The killer sees no survivor markers before the first scan");

    await banner(kai, "Zone closed");
    await banner(kai, "Scan active");
    await wait(kai, ".radar");
    await sleep(1000);
    check((await kai.page.locator(".lg-pin.is-enemy").count()) >= 1, "The scan reveals survivors on the killer's map");
    check((await kai.page.locator(".radar").count()) === 1, "The radar sweep plays while the scan is open");
    await shot(kai, "07-scan");

    await wait(cam, ".edge.danger");
    check(true, "Cam, standing outside the closed zone, gets the danger edge");
    await banner(cam, "Outside the safe zone");
    await sleep(2500);
    check(/\d:\d\d/.test(await cam.page.locator(".alert.danger .clock").innerText()), "Cam sees a return-to-safety countdown");
    await shot(cam, "08-red-zone");

    await banner(cam, "Eliminated");
    await wait(cam, ".out");
    check(true, "Cam is eliminated after the grace period and sees the out panel");
    await shot(cam, "09-eliminated");
    await kai.page.waitForFunction(() => !document.querySelector(".radar"));
    await sleep(500);
    check((await kai.page.locator(".lg-pin.is-enemy").count()) === 0, "Survivors are hidden again when the scan ends");
    await shot(kai, "10-after-scan");

    // ------------------------------------------------------------- radar lock
    console.log("Radar lock");
    await move(kai, at(180, 10)); // 50 m from Sam: out of lock range
    await sleep(3500);
    await move(kai, at(180, 40)); // 20 m from Sam, who stands 60 m out: inside the 25 m lock range
    await banner(kai, "Target detected");
    check((await kai.page.locator(".btn.tag").count()) === 0, "There is no Tag button any more");
    await kai.page.waitForSelector(".alert.lock.is-killer");
    check(true, "The killer sees a lock-progress card");
    await banner(sam, "Radar lock detected");
    await sam.page.waitForSelector(".alert.lock.is-survivor");
    check(true, "The survivor gets a RADAR LOCK DETECTED warning and a lock card");
    check(!(await sam.page.locator(".alert.lock").innerText()).includes("Kai"), "The survivor's lock card does not name the killer");
    await shot(kai, "11a-lock-killer");
    await shot(sam, "11b-lock-survivor");

    // The killer steps out of range before the lock completes: lock lost, then back in for the capture.
    await move(kai, at(180, 5));
    await banner(kai, "Target lost");
    check(true, "Leaving range cancels the lock (TARGET LOST)");
    await shot(kai, "11c-target-lost");
    await move(kai, at(180, 40));
    await banner(kai, "Target captured", 60_000);
    check(true, "Staying in range for the full lock captures the survivor (TARGET CAPTURED)");
    await banner(sam, "Caught");
    await shot(sam, "11-caught");

    // ------------------------------------------------------------- end
    for (const p of [kai, sam, cam]) await wait(p, ".end");
    const kaiEnd = await kai.page.locator(".end h1").innerText();
    const samEnd = await sam.page.locator(".end h1").innerText();
    check(kaiEnd === "Victory", `Killer sees "${kaiEnd}"`);
    check(samEnd === "Defeat", `Survivor sees "${samEnd}"`);
    check((await kai.page.locator(".final li").count()) === 3, "The end screen lists all three players");
    await shot(kai, "12-end-victory");
    await shot(sam, "13-end-defeat");

    for (const p of [kai, sam, cam]) {
      check(p.leaks.length === 0, `${p.name}: no hidden positions in ${p.frames} server messages${p.leaks.length ? ` (${p.leaks[0]})` : ""}`);
    }

    await kai.page.getByRole("button", { name: "Back to start" }).click();
    await wait(kai, "form.sheet");
    check(true, "Back to start returns to the landing screen");
  } catch (e) {
    failures++;
    console.log(`FAIL  ${(e as Error).message}`);
    for (const p of [kai, sam, cam]) await shot(p, `fail-${p.name}`).catch(() => undefined);
  } finally {
    clearInterval(jitter);
    await browser.close();
    await server.close();
  }
  console.log(failures === 0 ? "\nAll UI checks passed." : `\n${failures} UI check(s) failed.`);
  console.log(`Screenshots: ${OUT}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
