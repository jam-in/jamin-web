// ============================================================
// playback.js — Web Audio engine that keeps recorded voice tracks
// in sync with the YouTube video.
// -------------------- SYNC MODEL --------------------
// The YouTube player and the Web Audio clock (AudioContext.currentTime)
// are two independent timelines. To sync them we keep a single "anchor"
// that maps one to the other at a known instant:
//
//     videoTime  ≈  anchorVideo + (audioCtx.currentTime - anchorAudio)
//
// When the video starts playing we record the anchor, then schedule every
// clip relative to it:
//
//     clip should sound at videoTime == clip.startTime
//     => audioStartAt = anchorAudio + (clip.startTime - anchorVideo)
//
// A clip already "in progress" at anchor time is started immediately with
// an intra-clip offset of (anchorVideo - clip.startTime).
//
// -------------------- DRIFT FIXES --------------------
// Drift sources: buffering hiccups, the user seeking, and slow clock skew
// between the media element and the audio hardware. We run a watchdog tick
// (4×/sec) that compares the *expected* video time (from the anchor) with
// the *actual* player.getCurrentTime():
//
//   * |error| > SEEK_THRESHOLD  -> treat as a seek/jump: stop everything,
//                                  re-anchor, and reschedule from scratch.
//   * |error| > DRIFT_THRESHOLD -> gentle slip: re-anchor without tearing
//                                  down already-playing sources (they're
//                                  close enough; the new anchor keeps future
//                                  clips honest).
//
// This keeps long sessions tight without audible re-triggering on tiny skew.
//
// -------------------- LATENCY COMPENSATION --------------------
// A recorded take is ALWAYS late relative to the video by the capture
// round-trip latency R = (audio output latency the singer heard in their
// headphones) + (mic input latency) + (record-start delay). The browser/
// YouTube stack does not expose R, and it varies wildly (Bluetooth alone
// adds 100-300 ms), so we can't compute it — we compensate for it.
//
// We schedule each clip as if it started EARLIER by an offset:
//
//     effectiveStart = startTime - globalOffset - track.offset
//
// `globalOffset` is the calibrated default for this device; `track.offset`
// is a per-take nudge. Increasing the offset pulls the voice earlier
// (fixes "my voice plays late"); negative pushes it later.
// ============================================================

import { reportWarning } from "./errors.js";
import { effectiveStartTime } from "./core/sync-math.js";

const SEEK_THRESHOLD = 0.6;  // seconds — bigger than this == a jump/seek
const DRIFT_THRESHOLD = 0.18; // seconds — gentle re-anchor above this
const TICK_MS = 250;

export class PlaybackEngine {
  constructor(getVideoTime) {
    this.getVideoTime = getVideoTime; // () => current player time in seconds
    this.ctx = null;
    this.tracks = []; // [{ id, buffer, startTime, gainNode, volume, muted }]
    this.active = new Map(); // id -> AudioBufferSourceNode currently playing
    this.anchorAudio = 0;
    this.anchorVideo = 0;
    this.running = false;
    this.timer = null;
    this.globalOffset = 0;
    this.soloId = null;
  }

  _ctxReady() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  // Decode a stored track's blob into an AudioBuffer once and cache it.
  async addTrack(track) {
    const ctx = this._ctxReady();
    const arrayBuf = await track.blob.arrayBuffer();
    let buffer;
    try {
      buffer = await ctx.decodeAudioData(arrayBuf.slice(0));
    } catch (error) {
      // Some opus-in-webm blobs fail decodeAudioData on certain browsers.
      reportWarning("playback.addTrack.decode", track.id, error);
      return null;
    }
    const gainNode = ctx.createGain();
    gainNode.gain.value = track.muted ? 0 : (track.volume ?? 1);
    gainNode.connect(ctx.destination);

    const entry = {
      id: track.id,
      buffer,
      startTime: track.startTime,
      offset: track.offset ?? 0,
      gainNode,
      volume: track.volume ?? 1,
      muted: !!track.muted,
    };
    this.tracks.push(entry);
    // If we're already playing, fold the new track into the running mix.
    if (this.running) this._scheduleOne(entry);
    return entry;
  }

  setVolume(id, volume) {
    const t = this.tracks.find((x) => x.id === id);
    if (!t) return;
    t.volume = volume;
    this._applyGain(t);
  }

  setMuted(id, muted) {
    const t = this.tracks.find((x) => x.id === id);
    if (!t) return;
    t.muted = muted;
    this._applyGain(t);
  }

  setSolo(id) {
    this.soloId = id || null;
    for (const t of this.tracks) this._applyGain(t);
  }

  _applyGain(t) {
    if (t.muted || (this.soloId && this.soloId !== t.id)) {
      t.gainNode.gain.value = 0;
      return;
    }
    t.gainNode.gain.value = t.volume;
  }

  // Device-wide latency compensation (seconds). Reschedules live so the user
  // can hear the slider take effect during playback.
  setGlobalOffset(sec) {
    this.globalOffset = sec || 0;
    if (this.running) { this._stopAllSources(); this._scheduleAll(); }
  }

  // Per-take nudge (seconds) on top of the global offset.
  setTrackOffset(id, sec) {
    const t = this.tracks.find((x) => x.id === id);
    if (!t) return;
    t.offset = sec || 0;
    if (this.running) this._scheduleOne(t);
  }

  // Video time at which this clip's first sample should sound, after
  // subtracting the latency compensation (clips were recorded late).
  _effStart(t) {
    return effectiveStartTime(t, this.globalOffset);
  }

  removeTrack(id) {
    this._stopOne(id);
    this.tracks = this.tracks.filter((t) => t.id !== id);
    if (this.soloId === id) this.soloId = null;
  }

  clear() {
    this.stop();
    this.tracks = [];
    this.soloId = null;
  }

  // (Re)establish the anchor from the current video time.
  _anchor() {
    this.anchorAudio = this.ctx.currentTime;
    this.anchorVideo = this.getVideoTime();
  }

  _expectedVideoTime() {
    return this.anchorVideo + (this.ctx.currentTime - this.anchorAudio);
  }

  _scheduleOne(entry) {
    this._stopOne(entry.id); // never double-schedule
    const now = this.ctx.currentTime;
    const videoNow = this._expectedVideoTime();
    const effStart = this._effStart(entry);
    const dur = entry.buffer.duration;
    const clipEnd = effStart + dur;

    if (clipEnd <= videoNow) return; // clip is fully in the past

    const src = this.ctx.createBufferSource();
    src.buffer = entry.buffer;
    src.connect(entry.gainNode);
    src.onended = () => {
      if (this.active.get(entry.id) === src) this.active.delete(entry.id);
    };

    if (effStart <= videoNow) {
      // Already mid-clip: start now, skipping into the buffer.
      const offset = videoNow - effStart;
      src.start(now, Math.max(0, offset));
    } else {
      // Future clip: schedule precisely on the shared timeline.
      const when = this.anchorAudio + (effStart - this.anchorVideo);
      src.start(Math.max(now, when));
    }
    this.active.set(entry.id, src);
  }

  _scheduleAll() {
    for (const t of this.tracks) this._scheduleOne(t);
  }

  _stopOne(id) {
    const src = this.active.get(id);
    if (src) {
      try { src.onended = null; src.stop(); } catch { /* already stopped */ }
      this.active.delete(id);
    }
  }

  _stopAllSources() {
    for (const id of [...this.active.keys()]) this._stopOne(id);
  }

  // Called when the video starts playing.
  start() {
    const ctx = this._ctxReady();
    if (this.running) return;
    this.running = true;
    this._anchor();
    this._scheduleAll();
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  // Watchdog: correct drift / detect seeks.
  _tick() {
    if (!this.running) return;
    const expected = this._expectedVideoTime();
    const actual = this.getVideoTime();
    const error = actual - expected;

    if (Math.abs(error) > SEEK_THRESHOLD) {
      // The user seeked (or a big stall): rebuild the mix at the new position.
      console.log("SEEKED to ", actual);
      this._stopAllSources();
      this._anchor();
      this._scheduleAll();
    } else if (Math.abs(error) > DRIFT_THRESHOLD) {
      // Gentle skew: re-anchor so future scheduling stays accurate, and make
      // sure any clip that *should* be sounding now actually is.
      console.log("DRIFTED from ", expected, " to ", actual);
      this._anchor();
      for (const t of this.tracks) {
        const videoNow = this.anchorVideo;
        const effStart = this._effStart(t);
        const within = effStart <= videoNow && effStart + t.buffer.duration > videoNow;
        if (within && !this.active.has(t.id)) this._scheduleOne(t);
      }
    }
  }

  // Called when the video pauses/ends/buffers.
  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this._stopAllSources();
  }
}
