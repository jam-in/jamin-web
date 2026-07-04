# Build Spec — "Jam-in!" (record over YouTube)

Build a single-page web app called **Jam-in!** that lets a user play any YouTube
video, record voice takes over it through the microphone, and play those takes
back **in sync** with the video (karaoke / overdub style). Everything runs
client-side in the browser; recordings persist locally. Ship it as an installable,
offline-capable PWA.

This is a complete, one-shot specification — build the whole thing, working
end-to-end, then polish.

## Tech constraints (hard requirements)

- **Vanilla JavaScript (ES modules), HTML5, CSS only. No framework, no build
  step, no bundler.** `index.html` loads one `<script type="module">` entry point.
- **YouTube IFrame Player API** for the video.
- **MediaRecorder API** for microphone capture (prefer `audio/webm;codecs=opus`,
  fall back through `audio/webm`, `audio/ogg;codecs=opus`, `audio/mp4`).
- **Web Audio API** (`AudioContext`, `AudioBufferSourceNode`, `GainNode`) for
  synced multi-track playback/mixing.
- **IndexedDB** for storing audio blobs + metadata (no localStorage for blobs;
  localStorage only for small prefs).
- Must run from `http://localhost` or HTTPS (mic + IFrame API + service worker
  require a secure context — it will not work from `file://`).
- Keep code modular: separate UI, recording, sync engine, and storage concerns
  into small focused ES modules with descriptive names. Comment the audio-sync,
  Web Audio, and YouTube IFrame logic thoroughly.

## Core concept: three clocks must be reconciled

The hard part of this app is keeping recorded voice in sync with the video. Three
independent things must be reconciled:

1. **Video clock** — `player.getCurrentTime()`, unpredictable (buffering, seeks).
2. **Audio clock** — `AudioContext.currentTime`, monotonic and reliable.
3. **Mic capture** — `MediaRecorder` output is **always late** by an unobservable
   amount (headphone output latency + mic input latency + record-start delay;
   Bluetooth adds 100–300 ms). The browser does not expose this latency, so it
   cannot be computed — it must be user-tuned (see "Latency compensation").

The build MUST implement the sync engine described below; a naive "play the clip
at its timestamp" approach is not acceptable.

## Layout & UI

Single screen, dark-mode-first (also support light), mobile-friendly, clean and
minimal. A modern, polished look.

**Top bar:** app brand ("🎤 Jam-in! — record over YouTube"), and action buttons:
- **History** dropdown (🕑) — list of videos you've recorded over.
- **Export** / **Import** (zip).
- **Install** (shown only when the PWA install prompt is available).
- **Theme toggle** (🌙 / ☀️), persisted.

**Main stage (left/top):**
- **Search bar**: a text field + Search button. Accepts either a free-text query
  *or* a pasted YouTube URL / 11-char video ID (load directly if it parses as an
  ID/URL; otherwise run a search).
- **Player**: the embedded YouTube iframe, with a loading/error overlay on top.
- **Record row**: a big **● Record** button (becomes **■ Stop take** while
  recording) and a blinking **REC** indicator with an elapsed-time counter.
- **Timeline panel** (shown once a video is loaded): a horizontal timeline whose
  full width represents the video duration, with a ruler (`0:00` … total time),
  one **track row per take** showing its waveform positioned at the take's
  start time, a draggable **playhead**, and a **Global sync offset** control.
- **Empty hint** when there are no takes yet.
- Two checkboxes (both default **on**):
  - **Raw mic** — disable browser noise suppression / echo cancellation / auto-gain
    (recommended with headphones).
  - **Monitor takes** — hear previously recorded takes while recording (overdub).

**Modals:** a "Keep this take?" confirmation after each recording stops, and a
"Delete this take?" confirmation. A transient **toast** for status/success/error.

## Feature spec

### 1. Video loading
- Parse video ID from: bare 11-char ID, `youtube.com/watch?v=`, `youtu.be/`,
  `/embed/`, `/shorts/`, `youtube-nocookie.com`.
- Initialize `YT.Player` with `enablejsapi:1, playsinline:1, rel:0,
  modestbranding:1` and an explicit `origin` matching the page (required on
  localhost). Switching videos should reuse the existing player via
  `cueVideoById`.
- YouTube metadata (duration, title) arrives *after* the player is ready — poll
  for readiness (duration > 0 and `getVideoData().video_id` matches) with a ~15s
  deadline before laying out the timeline.
- On load: clear the engine, fetch this video's takes from IndexedDB, decode and
  add them to the engine, render the timeline, and capture the video's
  title/author for history.
- **On first run, load a known-embeddable default video** (use the YouTube IFrame
  API demo video id `M7lc1UVf-VE`) and show a hint telling the user many karaoke
  channels block embedding. Remember the last-loaded video in localStorage and
  restore it next time.
- **Error handling:** map YouTube error codes to friendly messages —
  `101/150` → "can't be embedded (uploader blocked it), try another",
  `153` → referrer/origin issue (open via localhost), `100` → not found,
  `2` → invalid id. Show errors in the player overlay + a toast.

### 2. Search (no API key)
- Browsers can't hit YouTube search directly (CORS), so query **public Piped and
  Invidious instances** (try a list of each in turn; they're flaky/rate-limited;
  return the first usable response; 6.5s per-request timeout). Normalize results
  to `{ videoId, title, author, duration }`.
- Build thumbnails directly from `https://i.ytimg.com/vi/<id>/mqdefault.jpg`
  (don't use the instance's proxied thumbnails).
- **Embeddability pre-filter:** many karaoke videos disable embedding. Probe each
  result via `https://noembed.com/embed?url=...` (CORS-enabled): drop results
  that are explicitly non-embeddable, but KEEP results whose status is unknown
  (probe failed) so the list never collapses on a hiccup. Cache probe results.
- Append a keyword like "karaoke" to free-text queries. Render results as a
  dropdown list (thumbnail, duration badge, title, author); clicking one loads it.
- Guard against out-of-order responses (only render the latest search).

### 3. Recording a take
- Lazily request mic permission; give specific friendly errors for
  `NotAllowedError`/`SecurityError` (denied), `NotFoundError` (no mic),
  `NotReadableError` (in use). Reuse the mic stream across takes; re-acquire it
  when the raw-mic constraint changes.
- On **Record**: stop monitor playback first (speaker bleed triggers echo
  cancellation even in raw mode), open the mic, **play the video**, and anchor the
  take's `startTime = player.getCurrentTime()`. Start `MediaRecorder` (gather data
  in ~250ms timeslices).
- Drive the session from **player state changes**: video PAUSED → pause the
  recording; PLAYING → resume; ENDED → finalize; BUFFERING → stop monitor. Track
  *active* elapsed time across pause/resume segments (don't count paused time).
- **Seek-during-record detection:** if `currentTime` jumps more than a threshold
  (~0.6s playing, ~0.15s paused) between 4×/sec UI ticks, auto-finalize the take.
- On **Stop**: stop the recorder → get the blob → decode it to measure true
  duration and compute waveform peaks → show the "Keep this take?" modal →
  if kept, persist and add to the mix; if not, discard.
- Use a re-entrancy guard so the record button / finalize can't double-fire.

### 4. The sync engine (Web Audio) — implement exactly this model
- Keep a single **anchor** mapping the two clocks, set when playback starts:
  `anchorAudio = ctx.currentTime`, `anchorVideo = videoTime`. Expected video time
  is `anchorVideo + (ctx.currentTime − anchorAudio)`.
- **Schedule** each clip so it sounds at video time `clip.startTime`:
  start it at `anchorAudio + (effStart − anchorVideo)`. A clip already mid-play at
  anchor time starts immediately at an in-buffer offset of `videoNow − effStart`.
  Each track gets its own `GainNode` for volume/mute.
- **Latency compensation:** play takes *earlier* than recorded to cancel capture
  latency: `effStart = startTime − globalOffset − trackOffset`.
  - `globalOffset` = device-wide value, default **0.2s**, range ~ −0.3s..+0.8s,
    adjustable in ±10ms steps, persisted in localStorage, double-click to reset.
    Increasing it pulls all voices earlier ("my voice plays late" → increase).
  - `trackOffset` = per-take nudge (±10ms, double-click to reset).
  - Changing either reschedules live so the user hears the effect immediately.
- **Drift watchdog** at 4×/sec: compare expected vs actual video time.
  - `|error| > 0.6s` → treat as a **seek**: stop all sources, re-anchor,
    reschedule from scratch.
  - `|error| > 0.18s` → **gentle re-anchor** (don't retrigger already-playing
    clips; just make sure anything that should be sounding now is).
- Start the engine when the video plays; stop it on pause/buffer/end.
- Decode each stored blob to an `AudioBuffer` once and cache it; if
  `decodeAudioData` fails (some opus-in-webm cases), skip that track gracefully.

### 5. Tracks UI (timeline)
- One row per take. Render the waveform as a segment positioned/scaled on the
  full-width timeline using the SAME `effStart` formula as the engine (so audio
  and visuals always agree), against the video duration.
- Per-take hover/active controls: **sync nudge** (◀ −10ms / readout / ▶ +10ms,
  dbl-click readout resets), **volume** (click = mute toggle, long-press = volume
  popover slider), **solo** (hear only this take), **delete** (with confirm).
- Persist volume/mute/offset changes to IndexedDB and apply them to the engine
  live. Redraw waveforms on resize and theme change. Sort takes newest-first.
- Draggable playhead: drag to scrub/seek; clicking the timeline (not on a control)
  toggles play/pause. Animate the playhead with `requestAnimationFrame` only while
  playing.

### 6. Persistence (IndexedDB)
- DB keyed by YouTube video ID. Two object stores:
  - **`tracks`** (autoincrement `id`, index on `videoId`): record shape
    `{ id, videoId, name, startTime, offset, duration, mimeType, volume, muted,
    peaks: number[], createdAt, blob }`.
  - **`videos`** (key `videoId`): `{ videoId, title, author, updatedAt }` for the
    history dropdown.
- Load all tracks for a video on load. Provide add/update/delete/get, plus a
  "videos that have recordings" query (joins counts + latest timestamp + title).

### 7. History dropdown
- List every video that has at least one take: title, author, video id, take
  count, sorted by most-recent take. Click to load. Link out to YouTube. Per-item
  delete that removes the video's metadata AND all its takes (with confirm). Mark
  the currently-loaded video.
- Capture title/author best-effort: poll `player.getVideoData()`, then fall back
  to the YouTube oEmbed endpoint.

### 8. Export / Import
- **Export**: bundle the current video's takes into a `.zip` containing
  `audio/<n>.<ext>` blobs + a `metadata.json` (`{ videoId, exportedAt, version,
  tracks:[...] }`). Implement a tiny dependency-free **STORE-only zip** writer
  (local headers + central directory + EOCD + CRC32) — no compression library
  (audio is already compressed). Download as `jamin-<videoId>.zip`.
- **Import**: read such a zip back (parse via the central directory), recreate the
  track rows in IndexedDB under the metadata's videoId, then reload that video (or
  offer to switch to it if different from the current one).

### 9. Waveforms
- Reduce a decoded `AudioBuffer` to ~80 normalized peak values (max-abs per
  bucket, normalized so quiet takes are still visible). Draw on a DPR-aware canvas
  using the theme accent color.

### 10. Error handling & robustness
- Central error helper: meaningful `console.error/warn` with a context label,
  plus an optional user-facing toast. Graceful degradation everywhere (search
  provider down, probe down, decode fails, permission denied, embed blocked).
- Guard async races: stale search responses, double record/finalize, metadata
  poll deadlines.

### 11. PWA / offline
- Web app manifest (name, theme color `#0f1117`, icon `icons/icon.svg`,
  standalone display). Service worker that **precaches the app shell** (all JS/CSS/
  html/manifest/icon) so the UI opens instantly offline, and runtime-caches other
  same-origin GETs. Let YouTube/network requests pass through untouched. Bump the
  cache name on changes. Show a custom **Install** button driven by
  `beforeinstallprompt`.

## Suggested module breakdown

`index.html`, `css/styles.css`, and ES modules: `main.js` (bootstrap/state wiring),
`youtube.js` (IFrame API + player wrapper + URL parsing), `video.js` (load flow +
metadata), `recorder.js` (MediaRecorder), `recording.js` (session lifecycle),
`playback.js` (sync engine), `db.js` (IndexedDB), `tracks-ui.js` (timeline rows),
`timeline-playhead.js`, `latency.js` (global offset), `search.js` + `search-ui.js`,
`history-ui.js`, `export-import.js` + `zip.js`, `waveform.js`, `ui.js` (toast/theme/
overlay/modals/formatting/DOM binding), `errors.js`, `constants.js`, `pwa.js`,
`sw.js`, `manifest.webmanifest`.

Use a single lightweight in-memory `app` state object (no store/framework);
`init*(app)` functions attach listeners and call back into render functions.

## Acceptance check
Serve over `http://localhost`, load the default video, press Record, voice over a few
seconds, Stop, Keep — the take appears on the timeline and plays back roughly in
sync on replay; the global-offset control audibly shifts timing; reload the page
and the take is still there; export to zip and re-import reproduces it.

## Out of scope (note, don't build)
- **Speaker mode / noise cancellation**: subtract the source audio so you can
  record without headphones (Web Audio analysis or a user-provided source track).
- **Final dubbed video export**: render canvas + mixed audio via MediaRecorder.
