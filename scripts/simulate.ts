/**
 * Plays the simulated-player scenarios against the real room service.
 *
 *   npm run sim                      # every scenario, seeds 1-5
 *   npm run sim -- gps-chaos 20      # one scenario, seeds 1-20
 */
import { runScenario, SCENARIOS } from "../src/sim";

const [only, seedsArg] = process.argv.slice(2);
const seeds = Number(seedsArg ?? 5);
let failed = 0;

for (const sc of SCENARIOS.filter((s) => !only || s.name === only)) {
  console.log(`\n${sc.name}: ${sc.description}`);
  for (let seed = 1; seed <= seeds; seed++) {
    const r = runScenario(sc, seed);
    const ok = r.failures.length === 0;
    if (!ok) failed++;
    console.log(
      `  ${ok ? "PASS" : "FAIL"} seed ${seed}: ${r.endReason ?? "no end"} at ${r.endedAtSec}s, ` +
        `${r.stats.captures} caught, ${r.stats.eliminations} eliminated (${r.eliminated.join(",") || "-"}), ` +
        `${r.stats.reveals} scans, ${r.stats.snapshots} snapshots`,
    );
    for (const f of r.failures.slice(0, 5)) console.log(`        ${f}`);
  }
}
console.log(failed === 0 ? "\nAll simulations passed." : `\n${failed} simulation run(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
