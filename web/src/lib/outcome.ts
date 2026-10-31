import type { MatchEndReason, Role } from "../../../src/engine";

export type Outcome = "victory" | "defeat" | "draw";

/** Killers win by catching (or outlasting) every survivor; survivors win by lasting to the end. */
export function matchOutcome(reason: MatchEndReason | null, role: Role): Outcome {
  switch (reason) {
    case "all_captured":
    case "no_survivors":
      return role === "killer" ? "victory" : "defeat";
    case "timeout":
    case "no_killers":
      return role === "survivor" ? "victory" : "defeat";
    default:
      return "draw";
  }
}

export function outcomeCopy(
  reason: MatchEndReason | null,
  outcome: Outcome,
): { title: string; subtitle: string } {
  const title = outcome === "victory" ? "Victory" : outcome === "defeat" ? "Defeat" : "Match over";
  const subtitle =
    reason === "all_captured"
      ? "Every survivor was caught."
      : reason === "no_survivors"
        ? "No survivors are left in the match."
        : reason === "timeout"
          ? "The zone closed with survivors still standing."
          : reason === "no_killers"
            ? "No killers are left in the match."
            : reason === "host_ended"
              ? "The host ended the match."
              : "The room was closed.";
  return { title, subtitle };
}
