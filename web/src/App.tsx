import { useEffect, useMemo } from "react";
import { useGame } from "./app/hooks";
import { actions } from "./app/runtime";
import { FxLayer } from "./fx/FxLayer";
import { End } from "./screens/End";
import { Game } from "./screens/Game";
import { Landing } from "./screens/Landing";
import { Lobby } from "./screens/Lobby";
import { errorText } from "./state/store";

export default function App() {
  const s = useGame();
  const initialCode = useMemo(
    () => (new URLSearchParams(location.search).get("code") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5),
    [],
  );

  useEffect(() => actions.restore(), []);

  const errorId = s.error?.id;
  useEffect(() => {
    if (errorId === undefined) return;
    const id = setTimeout(actions.clearError, 5500);
    return () => clearTimeout(id);
  }, [errorId]);

  let screen;
  if (!s.snapshot || !s.room) {
    screen = s.session ? (
      <main className="splash">
        <h1>Reconnecting to your match</h1>
        <p>Hold on. If this takes long, check your signal.</p>
        <button className="btn quiet" onClick={actions.leave}>Start over</button>
      </main>
    ) : (
      <Landing initialCode={initialCode} />
    );
  } else if (s.snapshot.matchPhase === "lobby") {
    screen = <Lobby snapshot={s.snapshot} room={s.room} startCheck={s.startCheck} />;
  } else if (s.snapshot.matchPhase === "ended") {
    screen = <End snapshot={s.snapshot} />;
  } else {
    screen = <Game snapshot={s.snapshot} room={s.room} receivedAt={s.receivedAt} />;
  }

  return (
    <>
      {s.net === "reconnecting" && (
        <div className="netbar" role="status">Connection lost. Reconnecting. Your place is saved.</div>
      )}
      {screen}
      <FxLayer fx={s.fx} />
      {s.error && (
        <div className="toast" role="alert">
          {errorText(s.error.code, s.error.message)}
        </div>
      )}
    </>
  );
}
