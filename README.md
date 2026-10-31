# LocalGrounds: Manhunt IRL

A real-world manhunt game. The arena is generated from players' live GPS: no predefined maps.
A circular outer boundary is fixed; a safe zone shrinks inside it; killers capture survivors by proximity,
validated by the server.

## Build phases

| # | Phase | Status |
|---|-------|--------|
| 1 | Geo core: distance, circle checks, safe-zone math, GPS freshness (with tests) | done |
| 2 | Zone engine: server-time phases, countdowns, pause/resume, match state machine, red-zone grace and penalties | done |
| 3 | Capture validation, role-based location visibility, 120 s reveals, game reducer + event stream | done |
| 4 | Backend: rooms, join/ready, authoritative state, filtered real-time (Node + WebSocket) | done |
| 5 | Frontend: Leaflet map, boundary/safe-zone/red-zone, markers, accuracy UI, game-style animations | done |
| 6 | Simulated players, safety features (pause/leave/host confirm), real-GPS test | done |

## Layout

```
src/shared   shared types
src/geo      pure geographic maths (no I/O): distance, boundary, zones, freshness
src/engine   pure game engine driven by an injected server clock: schedule, match state machine, red zone
src/server   protocol (strict parsing), RoomService (transport-agnostic), WebSocket server
tests        vitest suites
```

## Running the server

```
npm start            # PORT=8080 by default; ws path /ws, health check /healthz
npm run dev:server   # restart on change
```

Protocol (JSON over WebSocket): `create`, `join`, `resume`, `location`, `ready`, `configure`,
`confirm_safety`, `start`, `capture`, `pause`, `resume_match`, `end`, `leave`.
The server answers with `welcome` (secret token), `snapshot` (the player's own filtered view, pushed every
tick), `events`, `capture_result`, `location_ack`, `error`.

Server-side rules worth knowing:
- Players are identified by the connection/token, never by an id in a message (`capture` carries only the survivor id).
- Location reports have no client timestamp; the server stamps them. Reports are rate limited.
- Consent is required to create or join. Display names are sanitised (clients must still escape them).
- The host's GPS fix becomes the arena centre. Resizing the arena withdraws the host's safety confirmation.
- If the host leaves, the host role passes to another active player (who must re-confirm safety in the lobby).
- When a match ends, stored locations are wiped, and the room is removed after a short delay.
- Dropped players can `resume` with their token; idle/abandoned rooms are cleaned up.

## How the engine is used

```
client --LocationReport--> ingestLocation()  --> GameState (server only)
client --"tag s1"--------> attemptCapture()  --> server decides from stored samples
server timer (1 s) ------> tickGame()        --> zone/reveal/timeout events
GameState ---------------> projectForViewer(state, viewerId)  --> the ONLY payload a client gets
GameState.events --------> eventsFor(viewerId, events)        --> per-player event feed
```

Clients never send a timestamp, a distance, or a capture result. `projectForViewer` is the single
place location data leaves the server, and tests assert that hidden coordinates never appear in the
serialized payload.

## Game events → UI animations (Phase 5)

The engine emits typed events (no coordinates). The UI maps each one to feedback:

| Event | Feedback |
|-------|------------------|
| `zone_warning` | pulsing red ring on the next boundary, countdown, warning siren |
| `zone_shrunk` | boundary contracts with a sweep animation, screen shake |
| `reveal_started` / `reveal_ended` | radar sweep, player blips pop in, then fade out |
| `red_zone_entered` / `penalty_started` | red vignette, heartbeat pulse, HP bar drain |
| `captured` | tag-lock reticle, burst effect, "CAUGHT" banner |
| `eliminated` | glitch-out of the marker |
| `match_ended` | victory/defeat splash |

## Running the web app

```
npm run web:build   # builds web/dist
npm start           # serves the game and the WebSocket on one port (default 8080)
npm run web:dev     # Vite dev server with /ws proxied to the backend (LG_BACKEND, default localhost:8080)
npm run ui:smoke    # plays a full match in headless browsers with emulated GPS (needs web:build first)
```

Browsers only allow geolocation on **HTTPS or localhost**, so to test on phones serve the app over HTTPS
(a tunnel or a reverse proxy). Map tiles come from OpenStreetMap and fonts from Google Fonts; allow
those hosts if you restrict the network. Stationary phones often stop emitting GPS updates, so the
client re-confirms the last fix for up to 45 s before letting the signal show as lost.

## Simulation and field testing

```
npm run sim                    # all scenarios, seeds 1-5
npm run sim -- gps-chaos 25    # one scenario, 25 seeds
```

`src/sim` plays whole matches against the real room service on a virtual clock: seeded bots with GPS noise,
dropouts, stale fixes, urban-canyon bursts and spoofing. A monitor checks every message and true position:
no hidden coordinates leak, no capture without real proximity, no elimination of a player comfortably inside
the safe zone, and a paused match stays frozen. Scenarios cover hide-and-seek, bad GPS, spoofing, dropped
connections, emergency pause (host-only resume) and the host leaving. When you're ready for real phones, follow
[docs/FIELD-TEST.md](docs/FIELD-TEST.md).

## Develop

```
npm install
npm test
npm run typecheck
```

## Design rules

- The server is authoritative: clients only report location and render state.
- Every location check accounts for GPS accuracy; "uncertain" never eliminates a player.
- Safety first: playtest only in open, permitted, safe areas.
