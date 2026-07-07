// Single owner for in-memory tracks + IndexedDB + playback engine consistency.

import * as db from "../db.js";
import { resolvePlaybackBlob, stripBleedData, wasRecordedWithSpeakers } from "./bleeding.js";

export function createTrackStore({ engine, settings, bus }) {
  let tracks = [];
  let soloTrackId = null;
  let bleedingProcessor = null;

  function emitChanged() {
    bus.emit("tracks:changed", { tracks: [...tracks] });
  }

  async function reloadEngineTrack(track) {
    const blob = resolvePlaybackBlob(track, settings.getBleedingMode());
    await engine.replaceTrackBuffer(track.id, blob);
  }

  return {
    attachBleedingProcessor(processor) {
      bleedingProcessor = processor;
    },

    getTracks() {
      return tracks;
    },

    getSoloId() {
      return soloTrackId;
    },

    async loadForSession(videoId, sessionId) {
      engine.clear();
      soloTrackId = null;
      tracks = await db.getTracksBySession(videoId, sessionId);
      for (const track of tracks) {
        // Headphone/legacy takes can't bleed — discard any cached dry/reference
        // audio so they behave like plain recordings (and lose the Dry toggle).
        if (!wasRecordedWithSpeakers(track) && stripBleedData(track)) {
          await db.updateTrack(track);
        }
        const blob = resolvePlaybackBlob(track, settings.getBleedingMode());
        await engine.addTrack(track, { blob });
      }
      emitChanged();
    },

    async add(trackData) {
      const id = await db.addTrack(trackData);
      const track = { ...trackData, id };
      tracks.push(track);
      tracks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const blob = resolvePlaybackBlob(track, settings.getBleedingMode());
      await engine.addTrack(track, { blob });
      emitChanged();
      bus.emit("video:meta-updated");
      return track;
    },

    async update(track) {
      await db.updateTrack(track);
      if (track.offset != null) engine.setTrackOffset(track.id, track.offset);
      if (track.volume != null) engine.setVolume(track.id, track.volume);
      if (track.muted != null) engine.setMuted(track.id, track.muted);
    },

    async setTrackOffset(track, offsetSeconds) {
      track.offset = Math.max(0, Math.round(offsetSeconds * 1000) / 1000);
      engine.setTrackOffset(track.id, track.offset);
      await db.updateTrack(track);
      if (track.refBlob && bleedingProcessor) {
        await bleedingProcessor.reprocessTrack(track);
      }
    },

    async setBleedingData(track, { dryBlob, dryPeaks, refBlob, refSampleRate }) {
      track.dryBlob = dryBlob;
      track.dryPeaks = dryPeaks;
      track.refBlob = refBlob;
      track.refSampleRate = refSampleRate;
      await db.updateTrack(track);
      await reloadEngineTrack(track);
      emitChanged();
    },

    async setTrackDry(track, dry) {
      track.dry = !!dry;
      delete track.bleeding;
      await db.updateTrack(track);
      await reloadEngineTrack(track);
      emitChanged();
    },

    async refreshPlaybackForBleedingMode() {
      for (const track of tracks) {
        await reloadEngineTrack(track);
      }
      emitChanged();
    },

    async reprocessBleeding(track, reprocessFn) {
      if (!reprocessFn) return;
      await reprocessFn(track);
    },

    async setTrackVolume(track, volume, { persist = true } = {}) {
      track.volume = volume;
      if (!track.muted) engine.setVolume(track.id, volume);
      if (persist) await db.updateTrack(track);
    },

    async setTrackMuted(track, muted) {
      track.muted = muted;
      engine.setMuted(track.id, muted);
      await db.updateTrack(track);
    },

    setSolo(id) {
      soloTrackId = id || null;
      engine.setSolo(soloTrackId);
      bus.emit("settings:solo-changed", { soloTrackId });
    },

    async remove(trackId) {
      if (soloTrackId === trackId) {
        soloTrackId = null;
        engine.setSolo(null);
      }
      await db.deleteTrack(trackId);
      engine.removeTrack(trackId);
      tracks = tracks.filter((entry) => entry.id !== trackId);
      emitChanged();
      bus.emit("video:meta-updated");
    },

    async clearForSessionDelete() {
      engine.clear();
      tracks = [];
      soloTrackId = null;
      emitChanged();
    },
  };
}
