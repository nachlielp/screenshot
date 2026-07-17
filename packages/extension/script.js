import {
  isAuthenticated,
  getCurrentUser,
  signInWithGoogle,
  onAuthChange,
  syncClerkSession,
} from './utils/auth.js';
import { getRuntimeConfig } from './utils/runtime-config.js';
import { requestRuntime } from './utils/messaging.js';
import {
  ensureActiveSlideshowSession,
  getActiveSlideshowSession,
  setSlideshowSessionState,
  detachActiveSlideshowSession,
} from './utils/slideshow.js';

const slideshowBtn = document.getElementById("slideshowBtn");
const tabBtn = document.getElementById("tabBtn");
const fullPageBtn = document.getElementById("fullPageBtn");
const delayedTabBtn = document.getElementById("delayedTabBtn");
const screenWindowBtn = document.getElementById("screenWindowBtn");
const recordTabBtn = document.getElementById("recordTabBtn");
const recordScreenBtn = document.getElementById("recordScreenBtn");
const stopRecordingBtn = document.getElementById("stopRecordingBtn");
const annotateImageBtn = document.getElementById("annotateImageBtn");
const signInGoogleBtn = document.getElementById("signInGoogleBtn");
const libraryBtn = document.getElementById("libraryBtn");
const userName = document.getElementById("userName");
const userEmail = document.getElementById("userEmail");

const homePanel = document.getElementById("homePanel");
const slideshowPanel = document.getElementById("slideshowPanel");
const slideshowFrameCount = document.getElementById("slideshowFrameCount");
const slideshowFrameState = document.getElementById("slideshowFrameState");
const slideshowFrameHint = document.getElementById("slideshowFrameHint");
const slideshowTabBtn = document.getElementById("slideshowTabBtn");
const slideshowScreenshotBtn = document.getElementById("slideshowScreenshotBtn");
const slideshowFinishBtn = document.getElementById("slideshowFinishBtn");

const DELAY_MS = 3000;

// Lightweight error toast so failures are visible instead of dying in the console
let toastTimer = null;
const showPopupError = (message) => {
  let toast = document.getElementById('popup-error-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'popup-error-toast';
    toast.style.cssText = [
      'position:fixed', 'left:8px', 'right:8px', 'bottom:8px', 'z-index:9999',
      'background:#7f1d1d', 'color:#fecaca', 'border:1px solid #b91c1c',
      'border-radius:8px', 'padding:8px 12px', 'font-size:12px', 'line-height:1.4',
    ].join(';');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 6000);
};

const openDesktopCaptureWindow = async ({ mode = 'screenshot', slideshowSessionId = null } = {}) => {
  const params = new URLSearchParams({ mode });
  if (slideshowSessionId) {
    params.set('slideshowSessionId', slideshowSessionId);
  }

  // Chrome sizes the screen/window picker dialog relative to its parent
  // window, so the backdrop window has to be large for the picker to be usable.
  const width = Math.min(1280, screen.availWidth || 1280);
  const height = Math.min(900, screen.availHeight || 900);
  await chrome.windows.create({
    url: chrome.runtime.getURL(`desktop-capture.html?${params.toString()}`),
    type: 'popup',
    width,
    height,
    left: Math.max(0, Math.round(((screen.availWidth || width) - width) / 2)),
    top: Math.max(0, Math.round(((screen.availHeight || height) - height) / 2)),
    focused: true,
  });
};

function formatFrameCount(count) {
  return `${count} frame${count === 1 ? '' : 's'}`;
}

async function renderPopupMode(session = null) {
  const activeSession = session ?? await getActiveSlideshowSession();
  const frameCount = activeSession?.frames?.length ?? 0;
  const inSlideshowMode = Boolean(activeSession);

  homePanel.hidden = inSlideshowMode;
  slideshowPanel.hidden = !inSlideshowMode;

  if (!inSlideshowMode) {
    return;
  }

  slideshowFrameCount.textContent = String(frameCount);
  if (frameCount === 0) {
    slideshowFrameState.textContent = 'Ready to start';
    slideshowFrameHint.textContent = 'Capture your first frame from the tab or screenshot buttons below.';
  } else if (frameCount === 1) {
    slideshowFrameState.textContent = '1 frame captured';
    slideshowFrameHint.textContent = 'Add more frames, or finish to move into annotation mode.';
  } else {
    slideshowFrameState.textContent = `${formatFrameCount(frameCount)} captured`;
    slideshowFrameHint.textContent = 'Your slideshow draft is building up. Keep adding frames or finish to annotate.';
  }
  slideshowFinishBtn.disabled = frameCount === 0;
}

const takeTabScreenshot = async ({ includeLogs, fullPage, slideshowSessionId = null }) => {
  await requestRuntime({
    type: 'take-screenshot',
    target: 'service-worker',
    captureTarget: 'tab',
    includeLogs,
    fullPage,
    slideshowSessionId,
  }, { timeoutMs: fullPage ? 120000 : 30000 });
};

const scheduleTabScreenshot = async ({ includeLogs, delayMs }) => {
  await requestRuntime({
    type: 'schedule-screenshot',
    target: 'service-worker',
    captureTarget: 'tab',
    includeLogs,
    fullPage: false,
    delayMs,
  });
};

const openAnnotateImport = async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('import-image.html') });
};

const renderRecordingState = async () => {
  const { recording } = await chrome.storage.local.get(['recording']);
  const isRecording = Boolean(recording);

  if (recordTabBtn) recordTabBtn.hidden = isRecording;
  if (recordScreenBtn) recordScreenBtn.hidden = isRecording;
  if (stopRecordingBtn) stopRecordingBtn.hidden = !isRecording;
};

const sendRecordingCommand = async (message) => {
  const response = await chrome.runtime.sendMessage(message);
  if (response && response.success === false) {
    throw new Error(response.error || `${message.type} failed`);
  }
};

const updateAuthUI = async () => {
  try {
    const authenticated = await isAuthenticated();

    if (authenticated) {
      const user = await getCurrentUser();
      userName.textContent = user?.fullName || user?.firstName || 'Signed in';
      userEmail.textContent = user?.primaryEmailAddress?.emailAddress || 'Ready to share captures';
      signInGoogleBtn.style.display = 'none';
      libraryBtn.style.display = 'inline-flex';
    } else {
      userName.textContent = 'Not signed in';
      userEmail.textContent = 'Sign in to share your captures';
      signInGoogleBtn.style.display = 'inline-flex';
      libraryBtn.style.display = 'none';
    }
  } catch (error) {
    console.error('Error updating auth UI:', error);
    userName.textContent = 'Not signed in';
    userEmail.textContent = 'Sign in to share your captures';
    signInGoogleBtn.style.display = 'inline-flex';
    libraryBtn.style.display = 'none';
  }
};

const attemptSessionSyncOnOpen = async () => {
  try {
    await syncClerkSession({ notify: false });
  } catch (error) {
    console.debug('No web session available to sync on popup open:', error);
  }
};

const initializePopup = async () => {
  try {
    await attemptSessionSyncOnOpen();
    await updateAuthUI();
    await renderPopupMode();
    await renderRecordingState();

    slideshowBtn?.addEventListener("click", async () => {
      const session = await ensureActiveSlideshowSession();
      await renderPopupMode(session);
    });

    slideshowTabBtn?.addEventListener("click", async () => {
      const session = await ensureActiveSlideshowSession();
      await takeTabScreenshot({
        includeLogs: false,
        fullPage: false,
        slideshowSessionId: session.id,
      });
      window.close();
    });

    slideshowScreenshotBtn?.addEventListener("click", async () => {
      try {
        const session = await ensureActiveSlideshowSession();
        await openDesktopCaptureWindow({ slideshowSessionId: session.id });
        window.close();
      } catch (error) {
        console.error("Slideshow screenshot capture failed:", error);
        showPopupError(`Slideshow capture failed: ${error.message}`);
      }
    });

    slideshowFinishBtn?.addEventListener("click", async () => {
      const session = await getActiveSlideshowSession();
      if (!session || (session.frames?.length ?? 0) === 0) {
        return;
      }

      await setSlideshowSessionState(session.id, 'editing');
      await detachActiveSlideshowSession(session.id);
      await chrome.tabs.create({
        url: chrome.runtime.getURL(`slideshow-editor.html?id=${session.id}`),
      });
      window.close();
    });

    tabBtn?.addEventListener("click", async () => {
      try {
        await takeTabScreenshot({ includeLogs: true, fullPage: false });
        window.close();
      } catch (error) {
        console.error("Tab capture failed:", error);
        showPopupError(`Screenshot failed: ${error.message}`);
      }
    });

    fullPageBtn?.addEventListener("click", async () => {
      try {
        await takeTabScreenshot({ includeLogs: false, fullPage: true });
        window.close();
      } catch (error) {
        console.error("Full page capture failed:", error);
        showPopupError(`Full page capture failed: ${error.message}`);
      }
    });

    delayedTabBtn?.addEventListener("click", () => {
      delayedTabBtn.disabled = true;
      scheduleTabScreenshot({ includeLogs: true, delayMs: DELAY_MS }).catch((error) => {
        console.error("Delayed tab capture failed:", error);
      });
      window.close();
    });

    screenWindowBtn?.addEventListener("click", async () => {
      try {
        await openDesktopCaptureWindow();
        window.close();
      } catch (error) {
        console.error("Display capture failed:", error);
        showPopupError(`Display capture failed: ${error.message}`);
      }
    });

    recordTabBtn?.addEventListener("click", async () => {
      try {
        await sendRecordingCommand({ type: "start-recording", recordingType: "tab" });
        window.close();
      } catch (error) {
        console.error("Tab recording failed to start:", error);
        showPopupError(`Recording failed: ${error.message}`);
        await renderRecordingState();
      }
    });

    recordScreenBtn?.addEventListener("click", async () => {
      try {
        await openDesktopCaptureWindow({ mode: 'recording' });
        window.close();
      } catch (error) {
        console.error("Screen recording failed to start:", error);
        showPopupError(`Recording failed: ${error.message}`);
        await renderRecordingState();
      }
    });

    stopRecordingBtn?.addEventListener("click", async () => {
      try {
        await sendRecordingCommand({ type: "stop-recording" });
        window.close();
      } catch (error) {
        console.error("Failed to stop recording:", error);
        showPopupError(`Stop failed: ${error.message}`);
        await renderRecordingState();
      }
    });

    annotateImageBtn?.addEventListener("click", async () => {
      await openAnnotateImport();
      window.close();
    });

    signInGoogleBtn?.addEventListener("click", async () => {
      try {
        await signInWithGoogle();
        await updateAuthUI();
      } catch (error) {
        console.error('Google sign in error:', error);
      }
    });

    libraryBtn?.addEventListener("click", async () => {
      try {
        const config = await getRuntimeConfig();
        chrome.tabs.create({ url: `${config.siteUrl}/#/library` });
      } catch (error) {
        console.error('Library URL error:', error);
      }
    });

    onAuthChange(async () => {
      await updateAuthUI();
    });
  } catch (error) {
    console.error("[Popup Initialization] Error:", error);
  }
};

initializePopup();
