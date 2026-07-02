# Architecture

A reviewer's map of **Jam-in!** — a vanilla-JS PWA that plays a YouTube video,
records voice takes over it, and replays those takes *in sync* with the video.
No framework, no build step: `index.html` loads `js/main.js` as an ES module
and everything else is imported from there.

## The big picture

```
                         ┌─────────────────────────────────────────┐
                         │              main.js                    │
                         │  composition root: services + stores    │
                         └───────────────┬─────────────────────────┘
                                         │
         ┌───────────────────────────────┼───────────────────────────────┐
         │                               │                               │
         ▼                               ▼                               ▼
  ┌─────────────┐                 ┌─────────────┐                 ┌─────────────┐
  │  Services   │                 │ js/core/*   │                 │  *-ui.js    │
  │  (stateless)│                 │   stores    │                 │  (DOM)      │
  │ player      │                 │ trackStore  │──events──▶      │ tracks-ui   │
  │ recorder    │                 │ videoStore  │                 │ history-ui  │
  │ engine      │                 │ settings    │                 │ search-ui   │
  │ elements    │                 │ recording   │                 │ …           │
  └──────┬──────┘                 └──────┬──────┘                 └─────────────┘
         │                               │
         │                               ▼
         │                        db.js (IndexedDB)
         └──────────────────▶ playback.js (Web Audio sync engine)
```

Three clocks/streams have to be reconciled, and that's where most of the complexity (and the bugs worth hunting) live:

1. **The video clock** — `player.getCurrentTime()` (YouTube, ~unpredictable).
2. **The audio clock** — `AudioContext.currentTime` (Web Audio, monotonic).
3. **The mic stream** — `MediaRecorder`, which is *always late* by an unobservable capture-latency amount.

## Module map

| Module | Responsibility | Notes for review |
| --- | --- | --- |
| `js/main.js` | **Composition root only.** Wires services, domain stores, event bus, and `init*()` calls. No shared god-object. | The only module that knows the full dependency graph. |
| `js/core/events.js` | Lightweight pub/sub (`EventTarget` wrapper). | UI modules subscribe; stores emit. |
| `js/core/track-store.js` | **Track consistency owner.** In-memory list + IndexedDB + engine mutations. | Every add/update/delete goes through here. |
| `js/core/video-store.js` | Current video id, load orchestration, metadata capture. | Emits `video:*` lifecycle events. |
| `js/core/settings-store.js` | Latency offset, raw-mic flag, search-sequence guard. | Persists prefs; pushes offset to engine. |
| `js/core/recording-session.js` | Recording state machine: start/pause/finalize, seek-detect, keep-take modal flow. | Saves via `trackStore.add()`. |
| `js/core/timeline-sync.js` | Polls until YouTube duration is known; emits `timeline:ready`. | Replaces old `app.syncTimelineLayout`. |
| `js/core/sync-math.js` | Shared `effectiveStartTime()` formula. | Used by `playback.js` and `tracks-ui.js`. |
| `js/youtube.js` | Loads the IFrame API once, parses video IDs/URLs, wraps `YT.Player`. | `STATE` enum, `parseVideoId`, metadata-readiness polling. |
| `js/video.js` | Pure helpers: YouTube error text, record-button enable, player overlay. | Load/meta logic moved to `video-store.js`. |
| `js/recorder.js` | `MediaRecorder` wrapper: mic constraints, mime picking, start/stop. | Raw-mic toggle disables echo cancel/noise suppression. |
| `js/recording.js` | Thin wiring: record button + player state → `recordingSession`. | No direct db/engine/track mutations. |
| `js/playback.js` | **Web Audio sync engine.** Anchors, schedules, drift watchdog, latency offset. | The heart of the app — read its header comment first. |
| `js/db.js` | IndexedDB persistence, keyed by `videoId`. | Two stores: `tracks` + `videos` (history metadata). |
| `js/tracks-ui.js` | Timeline track rows: waveform position, volume/mute/solo/nudge/delete. | Mutates via `trackStore`; subscribes to bus. |
| `js/timeline-playhead.js` | Playhead cursor, click-to-seek, click-to-play/pause. | Subscribes to `timeline:ready`, `playhead:refresh`. |
| `js/latency.js` | Device-wide sync-offset UI (persisted in `localStorage`). | Delegates to `settingsStore`. |
| `js/search.js` / `search-ui.js` | YouTube search via public Piped/Invidious instances + embeddability probe. | No API key; depends on flaky third-party instances. |
| `js/history-ui.js` | "Recorded videos" dropdown (opens on search-field focus). | Loads via `videoStore.load()`. |
| `js/menu-ui.js` | Logo dropdown menu: export/import/share, Advanced toggle, mic mode, About. | Owns `data-nudge`; delegates mic mode to `audio-devices`. |
| `js/export-import.js` / `zip.js` | Zip of audio blobs + `metadata.json`. | `zip.js` is a hand-rolled STORE-only zip (CRC32 + headers). |
| `js/waveform.js` | Downsample an `AudioBuffer` to peaks; draw canvas previews. | |
| `js/ui.js` | Toast, theme, overlay, `formatTime`, `escapeHtml`, modals, element binding. | `bindElements()` is the single source of DOM refs. |
| `js/errors.js` | `reportError` / `reportWarning` — console + optional toast. | |
| `js/constants.js` | Storage keys, default video, thresholds. | |
| `js/pwa.js` / `sw.js` / `manifest.webmanifest` | Install prompt + offline app-shell cache. | `sw.js` `SHELL` list must be kept in sync with files. |

## State model

There is **no framework**, but there *is* a deliberate store layer in `js/core/`.
`main.js` constructs immutable **services** (`player`, `recorder`, `engine`,
`elements`) and domain **stores** that own mutable state. Feature modules receive
narrow dependencies — never a monolithic `app` blob.

### Stores

| Store | Owns | Key methods |
| --- | --- | --- |
| `trackStore` | `tracks[]`, `soloTrackId` | `loadForVideo`, `add`, `update`, `remove`, `setSolo`, `setTrackOffset`, … |
| `videoStore` | `currentVideoId` | `load`, `loadInitial`, `captureMeta`, `getVideoId` |
| `settingsStore` | `latencyOffset`, raw mic, `searchSequence` | `setLatencyOffset`, `nudgeLatencyOffset`, `setRawMic`, `nextSearchSequence` |
| `recordingSession` | Recording flags, timers, segment accounting | `start`, `finalize`, `onPlayerStateChange`, `tickUi` |

The `engine` still keeps its *own* decoded-buffer copy of each track. A track's
truth lives in **three** places: IndexedDB (persistent), `trackStore` in-memory
list (UI), and `engine.tracks` (audio). **`trackStore` is the single mutation
owner** — it updates db → engine → memory in that order, then emits
`tracks:changed`. Review any new edit path to confirm it goes through the store,
not direct `db.*` / `engine.*` calls from UI code.

### Event bus

Stores emit lifecycle signals; UI modules subscribe in their `init*` / factory.
This replaces the old pattern of bolting render callbacks onto a shared object
(`app.renderTracks()`, `app.renderHistory()`, …).

| Event | Emitted when | Typical subscribers |
| --- | --- | --- |
| `tracks:changed` | Any track add/update/delete/clear | `tracks-ui`, `history-ui` |
| `video:loading` / `video:loaded` / `video:error` | Load lifecycle | `tracks-ui`, `timeline-sync`, playhead |
| `video:meta-updated` | History title saved | `history-ui` |
| `settings:latency-changed` | Global offset nudge | `tracks-ui` (waveform redraw) |
| `settings:solo-changed` | Solo toggle | engine updated in store; UI refreshes active class |
| `timeline:ready` | Video duration known | `tracks-ui`, playhead, `menu-ui` |
| `playhead:refresh` | Track list re-rendered | `timeline-playhead` |
| `recording:state-changed` | Start/pause/finalize | (reserved for future UI hooks) |

## Sync engine (the part to scrutinize)

`playback.js` has a long header comment that is the spec; the summary:

- **Anchor:** on play, store `anchorAudio = ctx.currentTime` and
  `anchorVideo = videoTime`. Expected video time is then
  `anchorVideo + (ctx.currentTime - anchorAudio)`.
- **Scheduling:** each clip should sound at video time `clip.startTime`, so it's
  started at `anchorAudio + (effStart - anchorVideo)`. A clip already mid-play
  at anchor time is started immediately with an in-buffer offset.
- **Latency compensation:** takes are recorded *late*, so the engine plays them
  *earlier*: `effStart = effectiveStartTime(track, globalOffset)` where
  `effectiveStartTime` lives in `js/core/sync-math.js`:
  `startTime - globalOffset - track.offset`
  (`globalOffset` = device default in `settingsStore`; `track.offset` = per-take
  nudge in `tracks-ui.js`). This value is unknowable, hence user-tuned.
- **Drift watchdog** (`_tick`, 4×/sec): compares expected vs actual video time.
  `|error| > SEEK_THRESHOLD (0.6s)` → treat as seek: stop, re-anchor,
  reschedule. `|error| > DRIFT_THRESHOLD (0.18s)` → gentle re-anchor without
  retriggering audible clips.

`tracks-ui.js` uses the same `effectiveStartTime()` helper to position waveforms —
they must stay in sync with the engine.

### Auto-sync (planned, not shipped)

A future `auto-sync.js` would auto-detect per-take offset by cross-correlating
the take's rhythm with a tab-audio reference of the song (Chromium desktop only).
The design is documented in the build spec; no module exists in the repo yet.

## Key flows

**Load a video** (`videoStore.load`): overlay → `player.load(id)` →
`trackStore.loadForVideo(id)` (clears engine, loads from IndexedDB, decodes into
engine) → `tracks:changed` + `video:loaded` → `timeline-sync` polls metadata
until duration is known → `timeline:ready` → `videoStore.captureMeta()` for the
history title → `video:meta-updated`.

**Record a take** (`recordingSession`): stop monitor playback → open mic → play
video, anchor `recStartVideoTime = currentTime` → `recorder.start()`. Player
state changes drive pause/resume; a large jump in `currentTime` between UI ticks
is treated as a seek and **auto-finalizes** the take. On stop → decode for
duration + peaks → confirm-keep modal → `trackStore.add()` (db + engine + memory
+ bus events).

**Replay**: driven by player state in `recordingSession` / `timeline-playhead.js` —
`PLAYING` starts the engine, `PAUSED`/`ENDED`/`BUFFERING` stop it.

## Review hot spots

- **Three-way track consistency** — confirm every edit path uses `trackStore`,
  not scattered `db.*` / `engine.*` calls from UI modules. Import is a partial
  exception: it writes directly to `db.addTrack` then reloads via `videoStore.load`.
- **Event coverage** — every store mutation should emit the right bus event; a
  missing subscription means stale UI (the main risk of the store refactor).
- **Recording session edge cases** in `recording-session.js`: seek-during-record,
  pause/resume timing, `finalizingRecording` re-entrancy guard, the elapsed-time
  accounting (`recActiveMs` + segment timestamps).
- **Async re-entrancy / races**: `settingsStore.nextSearchSequence()` guards stale
  search responses; `keepTakePending` / `finalizingRecording` guard the record
  button; metadata polling in `timeline-sync.js` has a 15s deadline.
- **Third-party fragility** in `search.js` (public instances) and
  `videoStore.captureMeta` (oEmbed) — failure handling and timeouts.
- **`sw.js` cache list** must list every shipped file (including `js/core/*`),
  and bump `CACHE` version on change, or users get stale assets.
- **`zip.js`** is hand-rolled (STORE only, little validation) — check bounds and
  the CRC/offset math if you care about robustness.
- **Security/escaping**: most DOM is built with `textContent` (safe), but
  `history-ui.js` uses `innerHTML` with `escapeHtml()` — verify nothing
  unescaped slips in.

## Out of scope (noted, not built)

Speaker-mode source-audio subtraction (record without headphones), final
mixed-down video export, and auto-sync tab-audio correlation — see the README
"Future phases".
