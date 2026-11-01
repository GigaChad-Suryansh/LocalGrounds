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

## Map: free satellite imagery

The map is satellite imagery by default (Esri World Imagery plus place labels), free to use with the attribution
shown on the map. Google's satellite tiles can't be used for free in a third-party app (their terms and billing
forbid it), so Esri is the closest free equivalent. Alternatives, all set at build time (see `.env.example`):

| Provider | Free tier | Notes |
|----------|-----------|-------|
| Esri World Imagery (default) | free with attribution, no key | for a large public launch, register a free ArcGIS developer key (about 2M tiles a month) |
| MapTiler satellite | free key, about 100k requests a month | non-commercial use on the free plan |
| Mapbox satellite | free key, about 200k loads a month | needs an account |
| OpenStreetMap streets | free | `VITE_TILE_STYLE=streets`; fair use only, not for heavy public traffic |

For a keyed provider set `VITE_TILE_URL`, `VITE_TILE_KEY`, `VITE_TILE_ATTRIBUTION` and add the host to
`EXTRA_IMG_SRC` so the Content-Security-Policy allows it. Keys in a browser app are visible to users, so restrict them
to your domain in the provider's dashboard.

## Deploying

One Node process serves the web app and the game WebSocket on one port, and keeps rooms in memory, so run **exactly one
instance** (a restart ends live matches). HTTPS is required for phone GPS; Fly.io and Render provide it.

```
# Fly.io (fly.toml is ready; change `app` and `primary_region`)
fly launch --no-deploy --copy-config
fly deploy

# Render: New > Blueprint, point it at this repo (render.yaml)

# Any Docker host
docker build -t localgrounds . && docker run -p 8080:8080 -e TRUST_PROXY=1 localgrounds
```

Settings are environment variables (`PORT`, `TRUST_PROXY`, `ALLOWED_ORIGINS`, `EXTRA_IMG_SRC`, `MAX_CONNECTIONS_PER_IP`;
see `.env.example`). Set `TRUST_PROXY=1` behind a proxy so the per-address connection limit uses the real client address.
Foreign-origin WebSocket handshakes are refused. The server logs one line a minute with room and connection counts, never
names or locations. The Docker image was not built in the development sandbox (no Docker daemon there), but the same steps
were run by hand: clean `npm ci` with production settings, then `tsx src/server/main.ts`, `/healthz` and `/` both answer.

## Radar Lock (capture)

A killer no longer taps to tag. When a killer is within the capture range (25 m, host-adjustable) of an
active survivor, the **server** starts a lock and fills it over 4 s of server time. The host can change the range and the
lock time (2 to 10 s) in the lobby.

- Entering range starts the lock; leaving range cancels it and progress goes back to 0. A running lock tolerates
  GPS jitter (it only breaks beyond 1.2x the range), and accuracy is forgiven by at most 10 m, as before.
- Bad, stale or suspicious location data pauses the lock (progress held), and cancels it after 3 s. A lock only advances
  while both samples are at most 2 s old, so silence can never complete one.
- Only the server steps locks (`src/engine/radarLock.ts`, from the tick and after each location report); there is no client
  capture message at all. The first lock to reach 100% captures the survivor; other locks on them end. Pause/resume
  doesn't count towards a lock. Scans (reveals) and red zones are independent of it.
- Killers see `TARGET DETECTED` with a progress bar, `TARGET LOST`, `TARGET CAPTURED`. A locked survivor sees
  `RADAR LOCK DETECTED` with vibration and sound, and only the progress: never who or where the killer is.

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
