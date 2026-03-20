import {
  saveSlideshowSession,
  getSlideshowSession,
  deleteSlideshowSession,
  getCapture,
  deleteCapture,
} from './db.js';

const ACTIVE_SLIDESHOW_SESSION_ID_KEY = 'activeSlideshowSessionId';

const compactObject = (value) => (
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  )
);

function normalizeFrames(frames) {
  return frames.map((frame, index) => ({
    ...frame,
    order: index + 1,
  }));
}

async function getStoredActiveSessionId() {
  const result = await chrome.storage.local.get([ACTIVE_SLIDESHOW_SESSION_ID_KEY]);
  return result[ACTIVE_SLIDESHOW_SESSION_ID_KEY] || null;
}

export async function setActiveSlideshowSessionId(sessionId) {
  if (!sessionId) {
    await chrome.storage.local.remove([ACTIVE_SLIDESHOW_SESSION_ID_KEY]);
    return;
  }

  await chrome.storage.local.set({
    [ACTIVE_SLIDESHOW_SESSION_ID_KEY]: sessionId,
  });
}

export async function getActiveSlideshowSessionId() {
  return await getStoredActiveSessionId();
}

export async function getActiveSlideshowSession() {
  const activeSessionId = await getStoredActiveSessionId();
  if (!activeSessionId) return null;

  const session = await getSlideshowSession(activeSessionId);
  if (!session) {
    await setActiveSlideshowSessionId(null);
    return null;
  }

  return session;
}

export async function ensureActiveSlideshowSession() {
  const existing = await getActiveSlideshowSession();
  if (existing) {
    return existing;
  }

  const now = Date.now();
  const session = {
    id: crypto.randomUUID(),
    state: 'capturing',
    title: undefined,
    frames: [],
    createdAt: now,
    updatedAt: now,
  };

  await saveSlideshowSession(session);
  await setActiveSlideshowSessionId(session.id);
  return session;
}

export async function updateSlideshowSession(sessionId, updater) {
  const session = await getSlideshowSession(sessionId);
  if (!session) {
    throw new Error('Slideshow session not found');
  }

  const nextSession = updater(structuredClone(session));
  nextSession.updatedAt = Date.now();
  nextSession.frames = normalizeFrames(nextSession.frames || []);
  await saveSlideshowSession(nextSession);
  return nextSession;
}

export async function appendFrameToSlideshowSession(sessionId, frameInput) {
  return await updateSlideshowSession(sessionId, (session) => {
    session.state = 'capturing';
    session.frames.push(compactObject({
      captureId: frameInput.captureId,
      order: session.frames.length + 1,
      hidden: false,
      source: frameInput.source,
      sourceUrl: frameInput.sourceUrl || undefined,
      filename: frameInput.filename || undefined,
      mimeType: frameInput.mimeType || undefined,
      width: frameInput.width,
      height: frameInput.height,
      captureTimestamp: frameInput.captureTimestamp || frameInput.deviceMeta?.timestamp,
    }));
    return session;
  });
}

export async function setSlideshowSessionState(sessionId, state) {
  return await updateSlideshowSession(sessionId, (session) => {
    session.state = state;
    return session;
  });
}

export async function updateSlideshowFrame(sessionId, captureId, updater) {
  return await updateSlideshowSession(sessionId, (session) => {
    session.frames = session.frames.map((frame) => (
      frame.captureId === captureId ? updater({ ...frame }) : frame
    ));
    return session;
  });
}

export async function getResolvedSlideshowSession(sessionId) {
  const session = await getSlideshowSession(sessionId);
  if (!session) return null;

  const captures = await Promise.all(
    session.frames.map((frame) => getCapture(frame.captureId))
  );

  return {
    ...session,
    frames: session.frames
      .map((frame, index) => ({
        ...frame,
        capture: captures[index] || null,
      }))
      .filter((frame) => frame.capture !== null),
  };
}

export async function deleteSlideshowFrame(sessionId, captureId) {
  const nextSession = await updateSlideshowSession(sessionId, (session) => {
    session.frames = session.frames.filter((frame) => frame.captureId !== captureId);
    return session;
  });

  await deleteCapture(captureId).catch(() => {});

  if (nextSession.frames.length === 0) {
    await clearSlideshowSession(sessionId, { deleteCaptures: false });
    return null;
  }

  return nextSession;
}

export async function clearSlideshowSession(sessionId, { deleteCaptures = true } = {}) {
  const session = await getSlideshowSession(sessionId);

  if (session && deleteCaptures) {
    for (const frame of session.frames || []) {
      await deleteCapture(frame.captureId).catch(() => {});
    }
  }

  await deleteSlideshowSession(sessionId);

  const activeSessionId = await getStoredActiveSessionId();
  if (activeSessionId === sessionId) {
    await setActiveSlideshowSessionId(null);
  }
}
