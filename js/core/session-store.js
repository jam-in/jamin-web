// Jam session lifecycle: create, ensure, current session id.

import * as db from "../db.js";
import { LEGACY_SESSION_ID, resolveSessionId, sessionStorageKey } from "./session-id.js";

export function createSessionStore({ bus }) {
  let currentSessionId = null;
  let currentVideoId = null;
  let currentCreatedAt = null;

  function emitChanged() {
    bus.emit("session:changed", {
      sessionId: currentSessionId,
      videoId: currentVideoId,
      createdAt: currentCreatedAt,
    });
  }

  async function create(videoId) {
    const sessionId = crypto.randomUUID();
    const createdAt = Date.now();
    const session = {
      id: sessionStorageKey(videoId, sessionId),
      sessionId,
      videoId,
      createdAt,
    };
    await db.putSession(session);
    currentSessionId = sessionId;
    currentVideoId = videoId;
    currentCreatedAt = createdAt;
    emitChanged();
    return session;
  }

  async function ensure(sessionId, videoId) {
    const resolved = resolveSessionId(sessionId);
    let session = await db.getSession(videoId, resolved);
    if (!session) {
      session = {
        id: sessionStorageKey(videoId, resolved),
        sessionId: resolved,
        videoId,
        createdAt: Date.now(),
      };
      await db.putSession(session);
    }
    currentSessionId = resolved;
    currentVideoId = videoId;
    currentCreatedAt = session.createdAt;
    emitChanged();
    return session;
  }

  return {
    getSessionId() {
      return currentSessionId;
    },

    getSession() {
      if (!currentSessionId || !currentVideoId) return null;
      return {
        sessionId: currentSessionId,
        videoId: currentVideoId,
        createdAt: currentCreatedAt,
      };
    },

    create,
    ensure,

    async ensureLegacy(videoId) {
      return ensure(LEGACY_SESSION_ID, videoId);
    },
  };
}
