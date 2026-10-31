import type { PlayerStatus, ViewerSnapshot } from "../../../src/engine";
import { actions } from "../app/runtime";
import { RoleMark, roleLabel } from "../components/ui";
import { matchOutcome, outcomeCopy } from "../lib/outcome";

function finalLabel(role: "killer" | "survivor", status: PlayerStatus): string {
  if (status === "left") return "Left";
  if (status === "captured") return "Caught";
  if (status === "eliminated") return "Eliminated";
  return role === "survivor" ? "Survived" : "Still hunting";
}

export function End({ snapshot }: { snapshot: ViewerSnapshot }) {
  const me = snapshot.self;
  const outcome = matchOutcome(snapshot.endReason, me.role);
  const copy = outcomeCopy(snapshot.endReason, outcome);
  const rows = [me, ...snapshot.others].sort((a, b) => (a.role === b.role ? 0 : a.role === "survivor" ? -1 : 1));

  return (
    <main className={`end is-${outcome}`}>
      <div>
        <h1>{copy.title}</h1>
        <p>{copy.subtitle}</p>
      </div>
      <ul className="final" aria-label="Final standings">
        {rows.map((p) => (
          <li key={p.id} className={p.id === me.id ? "me" : ""}>
            <RoleMark role={p.role} />
            <span className="who">
              {p.name}
              {p.id === me.id ? " (you)" : ""}
              <small>{roleLabel(p.role)}</small>
            </span>
            <span className={`state s-${p.status}`}>{finalLabel(p.role, p.status)}</span>
          </li>
        ))}
      </ul>
      <p className="help">Everyone's locations were deleted when the match ended.</p>
      <button className="btn primary" onClick={actions.leave}>Back to start</button>
    </main>
  );
}
