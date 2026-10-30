# LocalGrounds: Manhunt IRL

A real-world manhunt game. The arena is generated from players' live GPS: no predefined maps.
A circular outer boundary is fixed; a safe zone shrinks inside it; killers capture survivors by proximity,
validated by the server.

## Build phases

| # | Phase | Status |
|---|-------|--------|
| 1 | Geo core: distance, circle checks, safe-zone math, GPS freshness (with tests) | done |
| 2 | Zone engine: server-time phases, countdowns, red-zone grace and penalties | next |
| 3 | Capture validation, role-based location visibility, 120 s reveals | |
| 4 | Backend: rooms, join/ready, authoritative state, filtered real-time | |
| 5 | Frontend: Leaflet map, boundary/safe-zone/red-zone, markers, accuracy UI | |
| 6 | Simulated players, safety features (pause/leave/host confirm), real-GPS test | |

## Layout

```
src/shared   shared types
src/geo      pure geographic maths (no I/O): distance, boundary, zones, freshness
tests        vitest suites
```

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
