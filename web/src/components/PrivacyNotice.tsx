import { useEffect } from "react";

/** What the game collects and why, in plain words. Shown from the landing page. */
export function PrivacyNotice({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal is-fixed" role="dialog" aria-modal="true" aria-label="Privacy and safety" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <h2 className="h-sm">Privacy and safety</h2>
        <h3 className="h-xs">What we collect</h3>
        <ul className="plain">
          <li>The name you type, your role, and your live location while you are in a match.</li>
          <li>Nothing else: no account, no email, no analytics, no advertising.</li>
        </ul>
        <h3 className="h-xs">How it's used</h3>
        <ul className="plain">
          <li>The server uses your location only to run the game: the zone, the radar lock and the scans.</li>
          <li>Other players only see what the rules allow, for example everyone during a scan, or teammates.</li>
          <li>Locations are held in the server's memory, never saved to a database, and deleted when the match ends or you leave.</li>
          <li>Your browser keeps a temporary session key so you can rejoin if the page reloads. It is cleared when you close the tab.</li>
        </ul>
        <h3 className="h-xs">Third parties</h3>
        <ul className="plain">
          <li>The map comes from a tile provider (satellite imagery by Esri). It can see your IP address and the area of the map you look at, but not your name or the game you are in.</li>
        </ul>
        <h3 className="h-xs">Stay safe</h3>
        <ul className="plain">
          <li>Play only in open areas where it is allowed. Keep away from roads, water, building sites and private property.</li>
          <li>Never trespass or hide where you could be hurt. Walk, don't run. Anyone can pause the match from the menu.</li>
          <li>The game is for people old enough to play outdoors on their own. Younger players should be with an adult.</li>
        </ul>
        <button className="btn primary" onClick={onClose}>Got it</button>
      </div>
    </div>
  );
}
