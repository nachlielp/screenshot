import { saveCapture, cleanupExpiredCaptures } from './utils/db.js';
import { requestRuntime, requestTab } from './utils/messaging.js';
import {
    appendFrameToSlideshowSession,
    hasActiveCapturingSlideshowSession,
} from './utils/slideshow.js';

// Clean up expired captures on service worker startup
cleanupExpiredCaptures().catch(console.error);

const DEFAULT_ACTION_ICON = {
    16: "icons/not-recording.png",
    32: "icons/not-recording.png",
};

const RECORDING_ACTION_ICON = {
    16: "icons/recording.png",
    32: "icons/recording.png",
};

const SLIDESHOW_BADGE_COLORS = ["#2563eb", "#f59e0b"];
const SLIDESHOW_BADGE_TEXT = ["SL", "+"];
const SLIDESHOW_PULSE_INTERVAL_MS = 900;
const CAPTURE_VISIBLE_TAB_INTERVAL_MS = 550;
const DELAYED_CAPTURE_JOB_KEY = "pendingDelayedCapture";
const DELAYED_CAPTURE_ERROR_MS = 5000;
const DELAYED_CAPTURE_EXPIRY_BUFFER_MS = 15000;

let slideshowPulseIntervalId = null;
let visibleTabCaptureQueue = Promise.resolve();
let lastVisibleTabCaptureAt = 0;
let slideshowPulseStep = 0;
let offscreenCreationPromise = null;
let delayedCaptureErrorUntil = 0;
let delayedCaptureErrorTimeoutId = null;

const stopSlideshowPulse = () => {
    if (slideshowPulseIntervalId !== null) {
        clearInterval(slideshowPulseIntervalId);
        slideshowPulseIntervalId = null;
    }
    slideshowPulseStep = 0;
};

const getPendingDelayedCapture = async () => {
    const stored = await chrome.storage.session.get([DELAYED_CAPTURE_JOB_KEY]);
    const job = stored[DELAYED_CAPTURE_JOB_KEY] || null;

    if (job && Number.isFinite(job.expiresAt) && job.expiresAt <= Date.now()) {
        await chrome.storage.session.remove([DELAYED_CAPTURE_JOB_KEY]);
        return null;
    }

    return job;
};

const setPendingDelayedCapture = (job) => (
    chrome.storage.session.set({ [DELAYED_CAPTURE_JOB_KEY]: job })
);

const clearPendingDelayedCapture = () => (
    chrome.storage.session.remove([DELAYED_CAPTURE_JOB_KEY])
);

const applyDelayedCaptureActionIndicator = async ({ recording, remaining }) => {
    stopSlideshowPulse();
    await chrome.action.setIcon({ path: recording ? RECORDING_ACTION_ICON : DEFAULT_ACTION_ICON });
    await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
    await chrome.action.setBadgeText({ text: String(Math.max(1, remaining || 1)) });
    await chrome.action.setTitle({
        title: recording
            ? `Recording in progress — screenshot in ${Math.max(1, remaining || 1)}`
            : `Screenshot in ${Math.max(1, remaining || 1)}`,
    });
};

const applyDelayedCaptureErrorIndicator = async ({ recording }) => {
    stopSlideshowPulse();
    await chrome.action.setIcon({ path: recording ? RECORDING_ACTION_ICON : DEFAULT_ACTION_ICON });
    await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({ title: "Delayed screenshot failed" });
};

const applyIdleActionIndicator = async () => {
    stopSlideshowPulse();
    await chrome.action.setIcon({ path: DEFAULT_ACTION_ICON });
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Screenshot" });
};

const applyRecordingActionIndicator = async () => {
    stopSlideshowPulse();
    await chrome.action.setIcon({ path: RECORDING_ACTION_ICON });
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Recording in progress" });
};

const applySlideshowPulseFrame = async () => {
    const text = SLIDESHOW_BADGE_TEXT[slideshowPulseStep % SLIDESHOW_BADGE_TEXT.length];
    const color = SLIDESHOW_BADGE_COLORS[slideshowPulseStep % SLIDESHOW_BADGE_COLORS.length];
    slideshowPulseStep += 1;

    await chrome.action.setIcon({ path: DEFAULT_ACTION_ICON });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
    await chrome.action.setTitle({ title: "Slideshow capture in progress" });
};

const applySlideshowActionIndicator = async () => {
    await applySlideshowPulseFrame();

    if (slideshowPulseIntervalId !== null) {
        return;
    }

    slideshowPulseIntervalId = setInterval(() => {
        applySlideshowPulseFrame().catch((error) => {
            console.warn("Failed to update slideshow action pulse:", error);
        });
    }, SLIDESHOW_PULSE_INTERVAL_MS);
};

const refreshActionIndicator = async () => {
    const [{ recording }, delayedCapture] = await Promise.all([
        chrome.storage.local.get(["recording"]),
        getPendingDelayedCapture(),
    ]);

    if (delayedCapture && ["starting", "counting-down"].includes(delayedCapture.status)) {
        await applyDelayedCaptureActionIndicator({
            recording: Boolean(recording),
            remaining: delayedCapture.remaining,
        });
        return;
    }

    if (delayedCaptureErrorUntil > Date.now()) {
        await applyDelayedCaptureErrorIndicator({ recording: Boolean(recording) });
        return;
    }

    if (recording) {
        await applyRecordingActionIndicator();
        return;
    }

    const hasActiveSlideshow = await hasActiveCapturingSlideshowSession();
    if (hasActiveSlideshow) {
        await applySlideshowActionIndicator();
        return;
    }

    await applyIdleActionIndicator();
};

const showDelayedCaptureError = async () => {
    delayedCaptureErrorUntil = Date.now() + DELAYED_CAPTURE_ERROR_MS;
    if (delayedCaptureErrorTimeoutId !== null) {
        clearTimeout(delayedCaptureErrorTimeoutId);
    }

    await refreshActionIndicator();
    delayedCaptureErrorTimeoutId = setTimeout(() => {
        delayedCaptureErrorUntil = 0;
        delayedCaptureErrorTimeoutId = null;
        refreshActionIndicator().catch((error) => {
            console.warn("Failed to clear delayed capture error indicator:", error);
        });
    }, DELAYED_CAPTURE_ERROR_MS);
};

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
        return;
    }

    if (!changes.activeSlideshowSessionId && !changes.recording && !changes.type) {
        return;
    }

    refreshActionIndicator().catch((error) => {
        console.warn("Failed to refresh action indicator after storage change:", error);
    });
});

refreshActionIndicator().catch((error) => {
    console.warn("Failed to initialize action indicator:", error);
});

/**
 * Utility function: Get the active tab
 * @returns {Promise<chrome.tabs.Tab|null>} - The active tab object or null if no active tab is found
 */
const isCapturableTab = (tab) => (
    Boolean(tab?.url) &&
    !tab.url.startsWith('chrome://') &&
    !tab.url.startsWith('chrome-extension://')
);

const getActiveTab = async ({ windowId = null } = {}) => {
    if (Number.isInteger(windowId)) {
        const windowTabs = await chrome.tabs.query({ active: true, windowId });
        return isCapturableTab(windowTabs[0]) ? windowTabs[0] : null;
    }

    // First try to get the active tab in the last focused window
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (isCapturableTab(tabs[0])) {
        return tabs[0];
    }

    // Fallback: get the active tab in the current window
    const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (isCapturableTab(currentTabs[0])) {
        return currentTabs[0];
    }

    // Last resort: get any active tab that the extension can capture
    const allActiveTabs = await chrome.tabs.query({ active: true });
    return allActiveTabs.find(isCapturableTab) || null;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const captureVisibleTabForTab = (tabId, windowId) => {
    const capture = visibleTabCaptureQueue.then(async () => {
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId !== windowId || !tab.active) {
            throw new Error('The source tab is no longer active');
        }

        const elapsed = Date.now() - lastVisibleTabCaptureAt;
        if (elapsed < CAPTURE_VISIBLE_TAB_INTERVAL_MS) {
            await sleep(CAPTURE_VISIBLE_TAB_INTERVAL_MS - elapsed);
        }

        lastVisibleTabCaptureAt = Date.now();
        return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    });

    visibleTabCaptureQueue = capture.catch(() => {});
    return capture;
};

const ensureContentScript = async (tabId) => {
    try {
        await requestTab(tabId, { type: 'screenshot-content-ping' }, { timeoutMs: 1000 });
        return;
    } catch (error) {
        console.debug('Content script is not ready; injecting it once:', error.message);
    }

    await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
    });

    await requestTab(tabId, { type: 'screenshot-content-ping' }, { timeoutMs: 3000 });
};

/**
 * Utility function: Update recording status
 * @param {boolean} state - The current recording state (true for active, false for inactive)
 * @param {string} type - The type of recording (e.g., 'tab', 'screen', or '')
 */
const updateRecordingStatus = async (state, type) => {
    console.log("Updating recording status:", { state, type });
    await chrome.storage.local.set({ recording: state, type });
    await refreshActionIndicator();
};

/**
 * Utility function: Inject script into the current tab
 * @param {Object} scriptOptions - Options for the script to execute
 */
const executeScript = async (scriptOptions) => {
    const activeTab = await getActiveTab();
    if (activeTab) {
        // Don't inject into extension pages or chrome:// pages
        if (activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('chrome-extension://')) {
            console.log('Skipping script injection into:', activeTab.url);
            return;
        }
        scriptOptions.target = { tabId: activeTab.id };
        await chrome.scripting.executeScript(scriptOptions);
    }
};

/**
 * Ensures the offscreen document exists for media-based capture tasks.
 */
const ensureOffscreenDocument = async () => {
    if (offscreenCreationPromise) {
        return offscreenCreationPromise;
    }

    offscreenCreationPromise = (async () => {
        const contexts = await chrome.runtime.getContexts({});
        const offscreenDocument = contexts.find((ctx) => ctx.contextType === "OFFSCREEN_DOCUMENT");

        if (!offscreenDocument) {
            await chrome.offscreen.createDocument({
                url: "offscreen.html",
                reasons: ["USER_MEDIA", "DISPLAY_MEDIA"],
                justification: "Required for desktop screenshot and recording capture",
            });
        }

        await requestRuntime({
            type: 'offscreen-ping',
            target: 'offscreen',
        }, { timeoutMs: 3000 });
    })();

    try {
        await offscreenCreationPromise;
    } finally {
        offscreenCreationPromise = null;
    }
};

/**
 * Finishes a desktop screenshot already captured and saved by the
 * desktop-capture window: appends it to the active slideshow session or opens
 * it in the editor.
 * @param {{captureId: string, filename: string, mimeType: string, source: string, deviceMeta: object | null}} capture
 */
const finalizeDesktopScreenshot = async (capture, slideshowSessionId = null) => {
    const {
        captureId,
        filename,
        mimeType = 'image/png',
        source = 'screen',
        deviceMeta = null,
    } = capture || {};

    if (!captureId) {
        throw new Error("Desktop screenshot result is missing a capture id");
    }

    if (slideshowSessionId) {
        await appendFrameToSlideshowSession(slideshowSessionId, {
            captureId,
            source,
            filename,
            mimeType,
            width: deviceMeta?.screenWidth,
            height: deviceMeta?.screenHeight,
            captureTimestamp: deviceMeta?.timestamp,
            deviceMeta,
        });
        return;
    }

    const editorUrl = chrome.runtime.getURL(`editor.html?id=${captureId}`);
    await chrome.tabs.create({ url: editorUrl });
};

/**
 * Listener for tab activation events
 * @param {chrome.tabs.TabActiveInfo} activeInfo - Details of the activated tab
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const delayedCapture = await getPendingDelayedCapture();
    if (
        delayedCapture &&
        delayedCapture.windowId === activeInfo.windowId &&
        delayedCapture.tabId !== activeInfo.tabId &&
        delayedCapture.status !== 'capturing'
    ) {
        await cancelDelayedCapture('The original tab is no longer active', { showError: true });
    }

    const activeTab = await chrome.tabs.get(activeInfo.tabId);
    if (!activeTab || activeTab.url?.startsWith("chrome://") || activeTab.url?.startsWith("chrome-extension://")) {
        console.log("Exiting due to unsupported tab URL.");
        return;
    }

    const { recording, type } = await chrome.storage.local.get(["recording", "type"]);
    if (recording && type === "screen") {
        await executeScript({ files: ["content.js"] });
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    getPendingDelayedCapture().then((job) => {
        if (job?.tabId === tabId && job.status !== 'capturing') {
            return cancelDelayedCapture('The original tab was closed', { showError: true });
        }
        return null;
    }).catch((error) => {
        console.warn('Failed to cancel delayed capture after tab close:', error);
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'loading') {
        return;
    }

    getPendingDelayedCapture().then((job) => {
        if (job?.tabId === tabId && job.status !== 'capturing') {
            return cancelDelayedCapture('The original tab navigated', { showError: true });
        }
        return null;
    }).catch((error) => {
        console.warn('Failed to cancel delayed capture after navigation:', error);
    });
});

/**
 * Starts the recording process. Screen recordings are owned by the
 * desktop-capture window (it reports back via desktop-recording-started),
 * so only tab recordings start here.
 * @param {string} type - The type of recording ('tab')
 */
const startRecording = async (type) => {
    console.log("Starting recording:", type);
    if (type !== "tab") {
        throw new Error(`Unknown recording type: ${type}`);
    }

    await updateRecordingStatus(true, type);

    try {
        await handleTabRecording(true);
    } catch (error) {
        // Recording never started — roll the badge/state back so the UI is honest.
        await updateRecordingStatus(false, "");
        throw error;
    }
};

/**
 * Stops the recording process
 */
// Stop recording and clean up resources
const stopRecording = async () => {
    console.log("Stopping recording");
    await updateRecordingStatus(false, "");
    // Tab recordings live in the offscreen document, screen recordings in the
    // desktop-capture window — ask both, at most one has an active recording.
    const attempts = await Promise.allSettled([
        requestRuntime({ type: "stop-recording", target: "offscreen" }),
        requestRuntime({ type: "stop-recording", target: "desktop-capture" }),
    ]);
    await endTabCapture();

    if (attempts.every((attempt) => attempt.status === "rejected")) {
        throw new Error("No recording is in progress");
    }
};

// End the tab capture session
const endTabCapture = async () => {
    try {
        const stream = await chrome.tabCapture.getCapturedTabs();
        if (stream && stream.length > 0) {
            stream[0].getTracks().forEach((track) => track.stop());
        }
    } catch (error) {
        console.error("Error stopping tab capture:", error);
    }
};


/**
 * Handles tab recording
 * @param {boolean} start - Whether to start or stop the recording
 */
const handleTabRecording = async (start) => {
    if (start) {
        await ensureOffscreenDocument();

        const activeTab = await getActiveTab();
        if (!activeTab) {
            throw new Error("No recordable tab found");
        }

        const mediaStreamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
        await requestRuntime({
            type: "start-recording",
            target: "offscreen",
            source: "tab",
            data: mediaStreamId,
        });
    } else {
        await requestRuntime({ type: "stop-recording", target: "offscreen" });
    }
};

/**
 * Convert data URL to Blob without using fetch (to avoid CSP issues)
 */
const dataUrlToBlob = (dataUrl) => {
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const bstr = atob(parts[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
};

/**
 * Takes a screenshot of the active tab and opens it in preview tab
 */
const takeScreenshot = async (captureTarget = "tab", options = {}) => {
    const {
        fullPage = null,
        includeLogs = null,
        slideshowSessionId = null,
        windowId = null,
        tabId = null,
    } = options;
    const activeTab = Number.isInteger(tabId)
        ? await chrome.tabs.get(tabId)
        : await getActiveTab({ windowId });
    if (!isCapturableTab(activeTab)) {
        throw new Error("No capturable tab found (browser-internal pages can't be captured)");
    }
    if (Number.isInteger(windowId) && (activeTab.windowId !== windowId || !activeTab.active)) {
        throw new Error("The original tab is no longer active");
    }

    try {
        const storedPrefs = await chrome.storage.local.get(['fullPageScreenshot', 'networkCaptureEnabled']);
        const fullPageScreenshot = typeof fullPage === 'boolean' ? fullPage : (storedPrefs.fullPageScreenshot || false);
        const networkCaptureEnabled = typeof includeLogs === 'boolean'
            ? includeLogs
            : (storedPrefs.networkCaptureEnabled !== false);
        const isValidUrl = activeTab.url &&
            (activeTab.url.startsWith('http://') || activeTab.url.startsWith('https://'));

        let dataUrl;

        if (fullPageScreenshot) {
            if (!isValidUrl) {
                throw new Error('Full Page is only available on web pages');
            }

            console.log('Starting full page screenshot capture...');
            await ensureContentScript(activeTab.id);
            const response = await requestTab(
                activeTab.id,
                { type: 'capture-full-page' },
                { timeoutMs: 90000 }
            );

            if (!response?.dataUrl) {
                throw new Error(response?.error || 'Full Page capture returned no image');
            }

            dataUrl = response.dataUrl;
            console.log('Full page screenshot captured successfully');
        } else {
            dataUrl = await captureVisibleTabForTab(activeTab.id, activeTab.windowId);
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `screenshot-${timestamp}.png`;
        const blob = dataUrlToBlob(dataUrl);

        let consoleLogs = null;
        let networkLogs = null;
        let deviceMeta = null;

        if (isValidUrl) {
            try {
                await ensureContentScript(activeTab.id);
                const logsResponse = await requestTab(
                    activeTab.id,
                    { type: 'extract-console-network' },
                    { timeoutMs: 5000 }
                );
                deviceMeta = logsResponse?.deviceMeta || null;
                if (networkCaptureEnabled) {
                    consoleLogs = logsResponse?.consoleLogs?.length ? logsResponse.consoleLogs : null;
                    networkLogs = logsResponse?.networkLogs?.length ? logsResponse.networkLogs : null;
                }
            } catch (error) {
                console.error('Error extracting device metadata/logs:', error);
            }
        } else {
            console.log('Skipping extraction for non-http(s) URL:', activeTab.url);
        }

        const captureId = crypto.randomUUID();
        await saveCapture(captureId, blob, filename, 'image/png', consoleLogs, networkLogs, activeTab.url || null, deviceMeta);

        if (slideshowSessionId) {
            await appendFrameToSlideshowSession(slideshowSessionId, {
                captureId,
                source: 'tab',
                sourceUrl: activeTab.url || undefined,
                filename,
                mimeType: 'image/png',
                width: deviceMeta?.viewportWidth,
                height: deviceMeta?.viewportHeight,
                captureTimestamp: deviceMeta?.timestamp,
                deviceMeta,
            });
            return;
        }

        const editorUrl = chrome.runtime.getURL(`editor.html?id=${captureId}`);
        await chrome.tabs.create({ url: editorUrl });

        console.log(`Screenshot saved to preview: ${filename}${consoleLogs ? ` (${consoleLogs.length} console logs)` : ''}${networkLogs ? ` (${networkLogs.length} network entries)` : ''}`);
    } catch (error) {
        console.error("Error taking screenshot:", error);
        throw error;
    }
};

const cancelDelayedCapture = async (reason, { showError = false } = {}) => {
    const job = await getPendingDelayedCapture();
    if (job) {
        await requestTab(job.tabId, {
            type: 'delayed-capture-countdown-cancel',
            jobId: job.jobId,
        }, { timeoutMs: 1000 }).catch(() => {});
        await clearPendingDelayedCapture();
    }

    console.warn('Delayed capture cancelled:', reason);
    if (showError) {
        await showDelayedCaptureError();
    } else {
        await refreshActionIndicator();
    }
};

const scheduleScreenshot = async (captureTarget, options = {}) => {
    const existingJob = await getPendingDelayedCapture();
    if (existingJob) {
        throw new Error('A delayed screenshot is already counting down');
    }

    const activeTab = await getActiveTab();
    if (!activeTab) {
        throw new Error("No capturable tab found (browser-internal pages can't be captured)");
    }

    const delayMs = Number.isFinite(options.delayMs) ? Math.max(1000, options.delayMs) : 3000;
    const job = {
        jobId: crypto.randomUUID(),
        tabId: activeTab.id,
        windowId: activeTab.windowId,
        captureTarget,
        includeLogs: options.includeLogs,
        fullPage: options.fullPage,
        slideshowSessionId: options.slideshowSessionId || null,
        delayMs,
        remaining: Math.max(1, Math.ceil(delayMs / 1000)),
        status: 'starting',
        createdAt: Date.now(),
        expiresAt: Date.now() + delayMs + DELAYED_CAPTURE_EXPIRY_BUFFER_MS,
    };

    await setPendingDelayedCapture(job);
    await refreshActionIndicator();

    try {
        await ensureContentScript(activeTab.id);
        const countdownJob = { ...job, status: 'counting-down' };
        await setPendingDelayedCapture(countdownJob);
        const response = await requestTab(activeTab.id, {
            type: 'delayed-capture-countdown-start',
            jobId: job.jobId,
            durationMs: delayMs,
        }, { timeoutMs: 3000 });

        if (!response?.visible) {
            throw new Error(response?.error || 'The page countdown could not be displayed');
        }

        return { jobId: job.jobId };
    } catch (error) {
        await cancelDelayedCapture(error.message, { showError: true });
        throw error;
    }
};

const updateDelayedCaptureCountdown = async (request, sender) => {
    const job = await getPendingDelayedCapture();
    if (!job || job.jobId !== request.jobId || sender.tab?.id !== job.tabId) {
        throw new Error('Delayed screenshot countdown is no longer active');
    }
    if (!["starting", "counting-down"].includes(job.status)) {
        throw new Error('Delayed screenshot is no longer counting down');
    }

    const remaining = Math.max(1, Number(request.remaining) || 1);
    await setPendingDelayedCapture({
        ...job,
        status: 'counting-down',
        remaining,
    });
    await refreshActionIndicator();
};

const completeDelayedCapture = async (request, sender) => {
    const job = await getPendingDelayedCapture();
    if (!job || job.jobId !== request.jobId || sender.tab?.id !== job.tabId) {
        throw new Error('Delayed screenshot countdown is no longer active');
    }
    if (job.status !== 'counting-down') {
        throw new Error('Delayed screenshot is already being processed');
    }

    await setPendingDelayedCapture({ ...job, status: 'capturing' });
    await refreshActionIndicator();

    try {
        await takeScreenshot(job.captureTarget, {
            tabId: job.tabId,
            windowId: job.windowId,
            includeLogs: job.includeLogs,
            fullPage: job.fullPage,
            slideshowSessionId: job.slideshowSessionId,
        });
    } catch (error) {
        await showDelayedCaptureError();
        await requestTab(job.tabId, {
            type: 'delayed-capture-countdown-cancel',
            jobId: job.jobId,
        }, { timeoutMs: 1000 }).catch(() => {});
        throw error;
    } finally {
        await clearPendingDelayedCapture();
        await refreshActionIndicator();
    }
};

/**
 * Listener for runtime messages
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.target === "offscreen" || request.target === "desktop-capture") {
        return false;
    }

    (async () => {
        try {
            console.log("Message received in service worker:", request.type);
            switch (request.type) {
                case "start-recording":
                    await startRecording(request.recordingType);
                    sendResponse({ success: true });
                    break;
                case "desktop-recording-started":
                    await updateRecordingStatus(true, "screen");
                    sendResponse({ success: true });
                    break;
                case "desktop-recording-stopped":
                    await updateRecordingStatus(false, "");
                    sendResponse({ success: true });
                    break;
                case "stop-recording":
                    await stopRecording();
                    sendResponse({ success: true });
                    break;
                case "take-screenshot":
                    console.log("Taking screenshot...");
                    await takeScreenshot(request.captureTarget, {
                        includeLogs: request.includeLogs,
                        fullPage: request.fullPage,
                        slideshowSessionId: request.slideshowSessionId,
                    });
                    sendResponse({ success: true });
                    break;
                case "schedule-screenshot": {
                    console.log("Scheduling screenshot...", request.delayMs);
                    const scheduled = await scheduleScreenshot(request.captureTarget, {
                        delayMs: request.delayMs,
                        includeLogs: request.includeLogs,
                        fullPage: request.fullPage,
                        slideshowSessionId: request.slideshowSessionId,
                    });
                    sendResponse({ success: true, accepted: true, ...scheduled });
                    break;
                }
                case "delayed-capture-countdown-tick":
                    await updateDelayedCaptureCountdown(request, sender);
                    sendResponse({ success: true });
                    break;
                case "delayed-capture-countdown-complete":
                    await completeDelayedCapture(request, sender);
                    sendResponse({ success: true });
                    break;
                case "desktop-screenshot-complete":
                    console.log("Finalizing desktop screenshot...");
                    await finalizeDesktopScreenshot(
                        request.capture,
                        request.slideshowSessionId || null
                    );
                    sendResponse({ success: true });
                    break;
                case "capture-viewport-part":
                    try {
                        if (!Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.tab?.windowId)) {
                            throw new Error('Viewport capture request did not come from a tab');
                        }

                        const dataUrl = await captureVisibleTabForTab(sender.tab.id, sender.tab.windowId);
                        sendResponse({ success: true, dataUrl });
                    } catch (error) {
                        console.error("Error capturing viewport part:", error);
                        sendResponse({ success: false, error: error.message, dataUrl: null });
                    }
                    break;
                case "open-preview":
                    // Open preview tab (called from offscreen document)
                    const previewUrl = chrome.runtime.getURL(`video.html?id=${request.id}&type=${request.captureType}`);
                    await chrome.tabs.create({ url: previewUrl });
                    sendResponse({ success: true });
                    break;
                default:
                    console.warn("Unknown request type:", request.type);
                    sendResponse({ success: false, message: "Unknown request type" });
            }
        } catch (error) {
            sendResponse({ success: false, error: error.message });
        }
    })();
    return true; // Keeps the message channel open for asynchronous response
});
