// Single owner for in-memory tracks + IndexedDB + playback engine consistency.

import * as db from "../db.js";

export function createTrackStore({ engine, bus }) {
  let tracks = [];
  let soloTrackId = null;

  function emitChanged() {
    bus.emit("tracks:changed", { tracks: [...tracks] });
  }

  return {
    getTracks() {
      return tracks;
    },

    getSoloId() {
      return soloTrackId;
    },

    async loadForVideo(videoId) {
      engine.clear();
      soloTrackId = null;
      tracks = await db.getTracksByVideo(videoId);
      for (const track of tracks) await engine.addTrack(track);
      emitChanged();
    },

    async add(trackData) {
      const id = await db.addTrack(trackData);
      const track = { ...trackData, id };
      tracks.push(track);
      tracks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      await engine.addTrack(track);
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
      track.offset = Math.round(offsetSeconds * 1000) / 1000;
      engine.setTrackOffset(track.id, track.offset);
      await db.updateTrack(track);
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

    async clearForVideoDelete() {
      engine.clear();
      tracks = [];
      soloTrackId = null;
      emitChanged();
    },
  };
}
