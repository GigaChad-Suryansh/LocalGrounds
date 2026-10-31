# Real-GPS field test checklist

Run `npm run sim` and `npm run ui:smoke` first: if those fail, don't go outside.

## Before you go
- [ ] Pick an open, legal, safe area: no roads, water, construction or private land. Daylight only.
- [ ] 3+ phones (1 killer, 2 survivors). Charge them, turn off battery saver, allow location for the browser.
- [ ] Serve the app over **HTTPS** (phones block geolocation on plain HTTP): `npm run web:build && npm start`, then expose port 8080 with an HTTPS tunnel. Check `/healthz`.
- [ ] Start with the 30 m or 75 m arena, not 300 m.
- [ ] Agree a real-world stop word and a meeting point. Everyone knows the in-game pause button.

## In the lobby
- [ ] Host can't create a room until consent is ticked and GPS accuracy is 30 m or better.
- [ ] Invite link pre-fills the room code on the other phones.
- [ ] Start stays locked until the host confirms the area is safe and everyone is ready.

## During the match
- [ ] Each phone shows its own dot in the right place; accuracy chip looks sane.
- [ ] Walk 10 m, then stand still for 60 s: the signal must not drop to "No signal" (stationary heartbeat).
- [ ] Screen locked for 30 s, then unlocked: the phone resumes and reports again.
- [ ] Zone warning, then the shrink, happens when the countdown says, on all phones.
- [ ] Killer sees no survivor until a scan; the scan shows survivors for the full window, then they vanish.
- [ ] Survivor steps outside the safe zone: warning and grace countdown; stepping back in clears it.
- [ ] Stand near the boundary with a weak signal (under a tree or by a building): no elimination from a bad fix alone.
- [ ] Tag from about 15 m: first attempt locks on, second captures. Tag from 40 m: refused.
- [ ] Any player presses pause: everyone freezes; only the host can resume.
- [ ] A survivor leaves via the menu; the match carries on. Host leaves: another player becomes host.

## Afterwards
- [ ] End screen lists everyone; "Back to start" works.
- [ ] Note the accuracy values and any false eliminations or missed captures, and open an issue with the room code and time.
