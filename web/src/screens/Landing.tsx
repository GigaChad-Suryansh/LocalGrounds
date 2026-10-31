import { useState, type FormEvent } from "react";
import type { Role } from "../../../src/engine";
import { useGame, useStoredString } from "../app/hooks";
import { actions } from "../app/runtime";
import { Check, GpsChip, RoleMark, Seg } from "../components/ui";
import { canHost, gpsProblemText, HOST_MAX_ACCURACY_M } from "../lib/gps";

const RADII = [
  { value: 30, label: "30 m", hint: "Yard" },
  { value: 75, label: "75 m", hint: "Park corner" },
  { value: 150, label: "150 m", hint: "Park" },
  { value: 300, label: "300 m", hint: "Campus" },
];

/** The arena, drawn the way the game draws it: boundary, closing zone, a killer and a survivor. */
function ArenaMark() {
  return (
    <svg className="arena-mark" viewBox="0 0 240 240" role="img" aria-label="An arena with a closing safe zone">
      <defs>
        <pattern id="olive" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(90)">
          <rect width="8" height="8" className="olive-bg" />
          <rect width="3" height="8" className="olive-stripe" />
        </pattern>
        <pattern id="hazard" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="2.6" height="9" className="hazard-stripe" />
        </pattern>
        <mask id="hole">
          <rect width="240" height="240" fill="white" />
          <circle cx="120" cy="120" r="92" fill="black" />
        </mask>
      </defs>
      <rect width="240" height="240" fill="url(#olive)" mask="url(#hole)" />
      <circle cx="120" cy="120" r="92" className="hazard-ring" />
      <circle cx="120" cy="120" r="54" className="safe-disc" />
      <circle cx="120" cy="120" r="92" className="boundary" pathLength="1" />
      <circle cx="120" cy="120" r="54" className="safe-ring" />
      <path d="M62 78 74 100H50Z" className="mark-killer" />
      <circle cx="128" cy="124" r="7" className="mark-survivor" />
    </svg>
  );
}

export function Landing({ initialCode }: { initialCode: string }) {
  const { gps, sessionExpired, net } = useGame();
  const [tab, setTab] = useState<"host" | "join">(initialCode ? "join" : "host");
  const [name, setName] = useStoredString("lg.name");
  const [roleRaw, setRole] = useStoredString("lg.role", "survivor");
  const role: Role = roleRaw === "killer" ? "killer" : "survivor";
  const [radiusM, setRadiusM] = useState(150);
  const [code, setCode] = useState(initialCode);
  const [consent, setConsent] = useState(false);

  const cleanName = name.replace(/[<>]/g, "").trim();
  const codeOk = /^[A-Z0-9]{5}$/.test(code.trim().toUpperCase());
  const gpsText = gpsProblemText(gps);

  let blocker: string | null = null;
  if (!cleanName) blocker = "Enter a name.";
  else if (tab === "join" && !codeOk) blocker = "Enter the 5-character room code.";
  else if (!consent) blocker = "Agree to share your location to continue.";
  else if (gps.state !== "active") blocker = "Turn on location to continue.";
  else if (tab === "host" && !canHost(gps))
    blocker = `Your GPS is ±${Math.round(gps.accuracyM)} m. Hosting needs ±${HOST_MAX_ACCURACY_M} m or better, so move to open sky.`;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (blocker) return;
    if (tab === "host") actions.create({ name: cleanName, role, radiusM });
    else actions.join({ code: code.trim().toUpperCase(), name: cleanName, role });
  };

  return (
    <main className="landing">
      <header className="brand">
        <ArenaMark />
        <div>
          <h1>LocalGrounds</h1>
          <p>A manhunt played on the real map around you. The arena is wherever you're standing.</p>
        </div>
      </header>

      <form className="sheet" onSubmit={submit}>
        {sessionExpired && <p className="notice">Your last session ended. Start a new room or join again.</p>}
        {net === "reconnecting" && <p className="notice">Can't reach the server. Retrying.</p>}

        <div className="field">
          <label htmlFor="name">Your name</label>
          <input id="name" value={name} maxLength={20} autoComplete="nickname" onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="field">
          <span className="label" id="role-label">Your side</span>
          <div className="role-pick" role="radiogroup" aria-labelledby="role-label">
            {(["killer", "survivor"] as const).map((r) => (
              <button key={r} type="button" role="radio" aria-checked={role === r} className={role === r ? "on" : ""} onClick={() => setRole(r)}>
                <RoleMark role={r} size={26} />
                <strong>{r === "killer" ? "Killer" : "Survivor"}</strong>
                <small>{r === "killer" ? "Find survivors and tag them within 25 m." : "Stay hidden and inside the closing zone."}</small>
              </button>
            ))}
          </div>
        </div>

        <Seg
          label="Host or join"
          value={tab}
          onChange={setTab}
          options={[
            { value: "host", label: "Host a match", hint: "You're the centre" },
            { value: "join", label: "Join a match", hint: "Use a room code" },
          ]}
        />

        {tab === "host" ? (
          <div className="field">
            <span className="label">Arena size</span>
            <Seg label="Arena radius" value={radiusM} onChange={setRadiusM} options={RADII} />
            <p className="help">The circle is centred on your position when you create the room. You can change the size in the lobby.</p>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="code">Room code</label>
            <input
              id="code"
              className="code-input"
              value={code}
              maxLength={5}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            />
          </div>
        )}

        <section className="safety" aria-labelledby="safety-h">
          <h2 id="safety-h">Before you play</h2>
          <ul>
            <li>Play where the public is allowed and it's safe. Stay away from roads, water and private property.</li>
            <li>Walk, don't run. Nobody wins by getting hurt.</li>
            <li>Anyone in the match can pause it from the menu, at any time.</li>
          </ul>
          <Check checked={consent} onChange={setConsent}>
            I agree to share my live location with this game. The server uses it only during a match, other players see
            only what the rules allow, and it's deleted when the match ends.
          </Check>
        </section>

        <div className="locate">
          {gps.state === "active" ? (
            <GpsChip accuracyM={gps.accuracyM} />
          ) : (
            <button type="button" className="btn quiet" disabled={!consent || gps.state === "requesting"} onClick={actions.enableLocation}>
              {gps.state === "requesting" ? "Waiting for a GPS fix" : gps.state === "off" ? "Turn on location" : "Try location again"}
            </button>
          )}
          {gpsText && <p className="help warn" role="alert">{gpsText}</p>}
        </div>

        <button className="btn primary" type="submit" disabled={blocker !== null}>
          {tab === "host" ? "Create room" : "Join room"}
        </button>
        {blocker && <p className="help">{blocker}</p>}
      </form>
    </main>
  );
}
