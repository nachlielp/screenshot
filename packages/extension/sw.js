import { saveCapture, cleanupExpiredCaptures } from './utils/db.js';

// Clean up expired captures on service worker startup
cleanupExpiredCaptures().catch(console.error);

/**
 * Utility function: Get the active tab
 * @returns {Promise<chrome.tabs.Tab|null>} - The active tab object or null if no active tab is found
 */
const getActiveTab = async () => {
    // First try to get the active tab in the last focused window
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs.length && tabs[0].url && !tabs[0].url.startsWith('chrome://')) {
        return tabs[0];
    }
    
    // Fallback: get the active tab in the current window
    const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (currentTabs.length && currentTabs[0].url && !currentTabs[0].url.startsWith('chrome://')) {
        return currentTabs[0];
    }
    
    // Last resort: get any active tab that's not a chrome:// page
    const allActiveTabs = await chrome.tabs.query({ active: true });
    const validTab = allActiveTabs.find(tab => tab.url && !tab.url.startsWith('chrome://'));
    return validTab || null;
};

/**
 * Utility function: Update recording status
 * @param {boolean} state - The current recording state (true for active, false for inactive)
 * @param {string} type - The type of recording (e.g., 'tab', 'screen', or '')
 */
const updateRecordingStatus = (state, type) => {
    console.log("Updating recording status:", { state, type });
    chrome.storage.local.set({ recording: state, type });
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
 * Listener for tab activation events
 * @param {chrome.tabs.TabActiveInfo} activeInfo - Details of the activated tab
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {

    const activeTab = await chrome.tabs.get(activeInfo.tabId);
    if (!activeTab || activeTab.url.startsWith("chrome://") || activeTab.url.startsWith("chrome-extension://")) {
        console.log("Exiting due to unsupported tab URL.");
        return;
    }

    const { recording, type } = await chrome.storage.local.get(["recording", "type"]);
    if (recording && type === "screen") {
        await executeScript({ files: ["content.js"] });
    }
});

/**
 * Starts the recording process
 * @param {string} type - The type of recording (e.g., 'tab' or 'screen')
 */
const startRecording = async (type) => {
    console.log("Starting recording:", type);
    updateRecordingStatus(true, type);
    chrome.action.setIcon({ path: "icons/recording.png" });

    if (type === "tab") {
        await handleTabRecording(true);
    } else if (type === "screen") {
        await handleScreenRecording();
    }
};

/**
 * Stops the recording process
 */
// Stop recording and clean up resources
const stopRecording = async () => {
    console.log("Stopping recording");
    updateRecordingStatus(false, "");
    chrome.action.setIcon({ path: "icons/not-recording.png" });
    await handleTabRecording(false);
    await endTabCapture();
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
    const contexts = await chrome.runtime.getContexts({});
    const offscreenDocument = contexts.find((ctx) => ctx.contextType === "OFFSCREEN_DOCUMENT");

    if (!offscreenDocument && start) {
        await chrome.offscreen.createDocument({
            url: "offscreen.html",
            reasons: ["USER_MEDIA", "DISPLAY_MEDIA"],
            justification: "Required for tab recording",
        });
    }

    if (start) {
        const activeTab = await getActiveTab();
        if (!activeTab) return;

        const mediaStreamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
        chrome.runtime.sendMessage({ type: "start-recording", target: "offscreen", data: mediaStreamId });
    } else {
        chrome.runtime.sendMessage({ type: "stop-recording", target: "offscreen" });
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
const takeScreenshot = async () => {
    const activeTab = await getActiveTab();
    if (!activeTab) {
        console.error("No active tab found for screenshot");
        return;
    }

    try {
        // Check if full page screenshot is enabled
        const { fullPageScreenshot = false } = await chrome.storage.local.get('fullPageScreenshot');
        
        let dataUrl;
        
        if (fullPageScreenshot) {
            // Capture full page screenshot
            console.log('Starting full page screenshot capture...');
            try {
                // Inject content script - need content.js not page-interceptors.js
                await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    files: ['content.js']
                }).catch(() => {}); // Ignore if already injected
                
                console.log('Content script injected, requesting full page capture...');
                
                // Request full page screenshot from content script with longer timeout
                const response = await Promise.race([
                    chrome.tabs.sendMessage(activeTab.id, { type: 'capture-full-page' }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 60000))
                ]);
                
                if (response && response.dataUrl) {
                    console.log('Full page screenshot captured successfully');
                    dataUrl = response.dataUrl;
                } else {
                    console.warn('No dataUrl in response, falling back to visible area');
                    dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' });
                }
            } catch (error) {
                console.error('Error capturing full page, falling back to visible area:', error);
                dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' });
            }
        } else {
            // Capture only the visible tab area
            dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' });
        }
        
        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `screenshot-${timestamp}.png`;
        
        // Convert data URL to Blob (without fetch to avoid CSP issues)
        const blob = dataUrlToBlob(dataUrl);
        
        let consoleLogs = null;
        let networkLogs = null;
        let deviceMeta = null;
        
        // Check if network capture is enabled
        const { networkCaptureEnabled = true } = await chrome.storage.local.get(['networkCaptureEnabled']);

        const isValidUrl = activeTab.url && 
            (activeTab.url.startsWith('http://') || activeTab.url.startsWith('https://')) &&
            !activeTab.url.startsWith('chrome://') &&
            !activeTab.url.startsWith('chrome-extension://');
        
        if (isValidUrl) {
            try {
                // Inject content script if not already present
                await chrome.scripting.executeScript({
                    target: { tabId: activeTab.id },
                    files: ['content.js']
                }).catch(() => {}); // Ignore if already injected
                
                // Always collect device metadata; also grab console/network logs if enabled
                try {
                    const logsResponse = await chrome.tabs.sendMessage(activeTab.id, { type: 'extract-console-network' });
                    deviceMeta = logsResponse?.deviceMeta || null;
                    if (networkCaptureEnabled) {
                        consoleLogs = logsResponse?.consoleLogs?.length ? logsResponse.consoleLogs : null;
                        networkLogs = logsResponse?.networkLogs?.length ? logsResponse.networkLogs : null;
                    }
                } catch (logError) {
                    console.error('Error extracting device metadata/logs:', logError);
                }
            } catch (error) {
                console.error('Error during page data extraction:', error);
            }
        } else if (!isValidUrl) {
            console.log('Skipping extraction for non-http(s) URL:', activeTab.url);
        }
        
        // Save to IndexedDB with unique ID
        const captureId = crypto.randomUUID();
        await saveCapture(captureId, blob, filename, 'image/png', consoleLogs, networkLogs, activeTab.url || null, deviceMeta);
        
        // Open editor tab instead of preview
        const editorUrl = chrome.runtime.getURL(`editor.html?id=${captureId}`);
        await chrome.tabs.create({ url: editorUrl });
        
        console.log(`Screenshot saved to preview: ${filename}${consoleLogs ? ` (${consoleLogs.length} console logs)` : ''}${networkLogs ? ` (${networkLogs.length} network entries)` : ''}`);
    } catch (error) {
        console.error("Error taking screenshot:", error);
    }
};

/**
 * Handles screen recording with Full HD resolution
 */
const handleScreenRecording = async () => {
    const screenRecordingUrl = chrome.runtime.getURL("screenRecord.html");
    const currentTab = await getActiveTab();

    const newTab = await chrome.tabs.create({
        url: screenRecordingUrl,
        pinned: true,
        active: true,
        index: 0,
    });

    setTimeout(() => {
        chrome.tabs.sendMessage(newTab.id, {
            type: "start-recording",
            resolution: "1920x1080",
            focusedTabId: currentTab?.id,
        });
    }, 500);
};

/**
 * Opens a new tab to play a recorded video
 * @param {Object} videoData - Video details
 * @param {string} [videoData.url] - URL of the recorded video
 * @param {string} [videoData.base64] - Base64-encoded video data
 */
const openVideoPlaybackTab = async ({ url, base64 }) => {
    if (!url && !base64) return;

    const videoPlaybackTab = await chrome.tabs.create({ url: chrome.runtime.getURL("video.html") });
    setTimeout(() => {
        chrome.tabs.sendMessage(videoPlaybackTab.id, { type: "play-video", videoUrl: url, base64 });
    }, 500);
};

/**
 * Listener for runtime messages
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
        try {
            console.log("Message received in service worker:", request.type);
            switch (request.type) {
                case "start-recording":
                    await startRecording(request.recordingType);
                    sendResponse({ success: true });
                    break;
                case "stop-recording":
                    await stopRecording();
                    sendResponse({ success: true });
                    break;
                case "take-screenshot":
                    console.log("Taking screenshot...");
                    await takeScreenshot();
                    sendResponse({ success: true });
                    break;
                case "capture-viewport-part":
                    // Capture current viewport for full page screenshot stitching
                    try {
                        const tab = await getActiveTab();
                        if (tab) {
                            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
                            sendResponse({ success: true, dataUrl });
                        } else {
                            sendResponse({ success: false, dataUrl: null });
                        }
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
