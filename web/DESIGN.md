# LocalGrounds web: design notes

## Direction

The game is played outdoors, on a phone, in daylight and at dusk, on a real map. The first instinct
(dark neon "tactical HUD") is the generic default for games, so it was dropped. The identity comes
from **orienteering maps** instead: the sport where people race across real terrain between circles
printed on a paper map.

- Map-paper UI that stays legible in sun, with a dark variant for night games (`prefers-color-scheme`).
- The one memorable element is the **arena circle**: a magenta course-overprint line that draws itself
  on the landing page and shrinks in-game, with striped hatching for out-of-bounds and danger areas.
- Orienteering symbols carry meaning: a **triangle** (the start symbol) marks killers, a **circle** (a
  control) marks survivors, a **double circle** (the finish) marks the final zone.

## Tokens

| Token | Light | Dark | Used for |
|-------|-------|------|----------|
| paper | `#f2f5ee` | `#0f1b29` | page and panels (cool, slightly green: not cream) |
| ink | `#14263a` | `#e8eef3` | text and lines (navy, not black) |
| magenta | `#c8147d` | `#ff4fb0` | the course: arena boundary, primary actions |
| hazard | `#e23b2e` | `#ff6a5c` | red zone, damage, killers |
| terrain | `#2f8f5b` | `#4fd19a` | safe, ready, survivors |
| signal | `#d99100` | `#ffc233` | warnings (zone closing, weak GPS) |
| olive | `#8a8f2a` | `#a7ad45` | out-of-bounds stripes |

Type: **Barlow Condensed** (600/700) for numerals, banners and headings, like road and trail signage;
**Barlow** (400/500/600) for text. Tabular figures for every countdown. Labels are sentence case.

## Layout

```
Landing                Lobby (phone)            Game
+----------------+     +----------------+       +----------------+
| (( arena ))    |     |   map preview  |       | zone 2  0:34   |
|  LocalGrounds  |     |   (boundary)   |       | scan in 1:12   |
| [host|join]    |     +----------------+       |                |
| name / role    |     | code  K7P2Q    |       |   full map     |
| radius / code  |     | players        |       |                |
| safety + consent|    | host controls  |       | gps   [tag]    |
| [create]       |     | [ready]        |       +----------------+
+----------------+     +----------------+
```

Left-aligned text, one column on phones, map and panel side by side from 900 px.

## Motion

Motion is event-driven: every animation answers a game event (zone warning, shrink, scan, tag, capture,
red-zone entry, end). Nothing loops for decoration except what carries state (the scan sweep while a
reveal is open, the pulse on a closing zone, the danger edge in the red zone). `prefers-reduced-motion`
turns off shakes, sweeps and tweens; sounds and vibration have their own mute switch.

## Review against the default

- Dark HUD with one neon accent: replaced by light map-paper + magenta overprint (dark mode is a variant).
- Card grid with identical rounded corners: panels are separated by hairline rules and map-key style rows.
- All-caps tracked eyebrows and mono data labels: not used; labels are sentence case, numerals are
  Barlow Condensed with tabular figures.


## Revision 2: dark tactical HUD

The pale "map paper" look read as a web form, not a game, so the whole UI moved to a dark tactical HUD:
near-black map with a muted dark basemap, a cyan glowing safe zone, white dashed boundary, red hazard
stripes for the red zone, green circle = survivor, red triangle = killer (shape plus colour, never colour alone).
Panels are chamfered glass cards; Rajdhani for display type; glow only on things that matter (safe zone, primary
action, clocks). Banners are compact and sit below the HUD so they never cover the arena; none show on the end screen.
Always dark, so there is no light theme any more.
