import { isAuthenticated, getCurrentUser, signIn, signInWithGoogle, signOut, onAuthChange, syncClerkSession } from './utils/auth.js';
import { getRuntimeConfig } from './utils/runtime-config.js';
import { saveCapture } from './utils/db.js';

/**
 * Cache DOM elements for easy access.
 */
const recordTabButton = document.getElementById("tab");
const recordScreenButton = document.getElementById("screen");
const screenshotButton = document.getElementById("screenshot");
const screenshotTargetSelect = document.getElementById("screenshotTarget");
const captureHint = document.getElementById("captureHint");
const bodyElement = document.body;
const modeToggleSwitch = document.getElementById("modeToggle");
const modeLabelElement = document.getElementById("modeLabel");
const networkCaptureToggle = document.getElementById("networkCaptureToggle");
const fullPageToggle = document.getElementById("fullPageToggle");

// Auth elements
const signInGoogleBtn = document.getElementById("signInGoogleBtn");
const syncAuthBtn = document.getElementById("syncAuthBtn");
const signOutBtn = document.getElementById("signOutBtn");
const libraryBtn = document.getElementById("libraryBtn");
const signedInView = document.getElementById("signedInView");
const signedOutView = document.getElementById("signedOutView");
const userName = document.getElementById("userName");
const userEmail = document.getElementById("userEmail");

/**
 * Sets the default theme mode (light/dark) based on system preference or localStorage.
 */
const setDefaultThemeMode = () => {
    const prefersDarkMode = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const savedThemeMode = localStorage.getItem("modeToggle");
    const isDarkMode = savedThemeMode !== null ? JSON.parse(savedThemeMode) : prefersDarkMode;

    bodyElement.classList.toggle("light-mode", !isDarkMode);
    modeToggleSwitch.checked = isDarkMode;
    modeLabelElement.textContent = isDarkMode ? "🌙 Mode" : "🌞 Mode";
};

/**
 * Toggles the light/dark theme mode and saves the preference to localStorage.
 */
const toggleThemeMode = () => {
    const isDarkMode = modeToggleSwitch.checked;
    bodyElement.classList.toggle("light-mode", !isDarkMode);
    modeLabelElement.textContent = isDarkMode ? "🌙 Mode" : "🌞 Mode";
    localStorage.setItem("modeToggle", JSON.stringify(isDarkMode));
};

/**
 * Loads the network capture preference from storage
 */
const loadNetworkCapturePreference = async () => {
    const result = await chrome.storage.local.get(["networkCaptureEnabled"]);
    const isEnabled = result.networkCaptureEnabled !== false; // Default to true
    networkCaptureToggle.checked = isEnabled;
};

/**
 * Saves the network capture preference to storage
 */
const saveNetworkCapturePreference = async () => {
    const isEnabled = networkCaptureToggle.checked;
    await chrome.storage.local.set({ networkCaptureEnabled: isEnabled });
};

/**
 * Loads the full page screenshot preference from storage
 */
const loadFullPagePreference = async () => {
    const result = await chrome.storage.local.get(["fullPageScreenshot"]);
    const isEnabled = result.fullPageScreenshot || false; // Default to false
    fullPageToggle.checked = isEnabled;
};

/**
 * Saves the full page screenshot preference to storage
 */
const saveFullPagePreference = async () => {
    const isEnabled = fullPageToggle.checked;
    await chrome.storage.local.set({ fullPageScreenshot: isEnabled });
};

/**
 * Builds display-media options that bias the picker toward a screen or window.
 * @param {"screen"|"window"} captureTarget
 * @returns {DisplayMediaStreamOptions}
 */
const getDisplayMediaOptions = (captureTarget) => ({
    video: {
        width: { ideal: 3840 },
        height: { ideal: 2160 },
        frameRate: { ideal: 30, max: 30 },
    },
    audio: false,
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    systemAudio: "exclude",
    monitorTypeSurfaces: captureTarget === "screen" ? "include" : "exclude",
});

/**
 * Converts a canvas into a PNG blob.
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
const canvasToBlob = (canvas) => (
    new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error("Failed to create screenshot blob"));
                return;
            }

            resolve(blob);
        }, "image/png");
    })
);

/**
 * Captures a still image from getDisplayMedia and opens it in the editor.
 * @param {"screen"|"window"} captureTarget
 * @returns {Promise<void>}
 */
const captureDesktopScreenshot = async (captureTarget) => {
    const stream = await navigator.mediaDevices.getDisplayMedia(getDisplayMediaOptions(captureTarget));

    try {
        const [videoTrack] = stream.getVideoTracks();
        if (!videoTrack) {
            throw new Error("No video track found for desktop capture");
        }

        const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;

        await new Promise((resolve) => {
            video.onloadedmetadata = () => resolve();
        });
        await video.play();

        if (typeof video.requestVideoFrameCallback === "function") {
            await new Promise((resolve) => video.requestVideoFrameCallback(() => resolve()));
        } else {
            await new Promise((resolve) => setTimeout(resolve, 150));
        }

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("Could not create canvas context");
        }

        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        const blob = await canvasToBlob(canvas);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `${captureTarget}-screenshot-${timestamp}.png`;
        const captureId = crypto.randomUUID();

        await saveCapture(captureId, blob, filename, 'image/png', null, null, null, {
            captureSurface: captureTarget,
            displaySurface: settings.displaySurface || null,
            screenWidth: canvas.width,
            screenHeight: canvas.height,
            timestamp: new Date().toISOString(),
        });

        const editorUrl = chrome.runtime.getURL(`editor.html?id=${captureId}`);
        await chrome.tabs.create({ url: editorUrl });
    } finally {
        stream.getTracks().forEach((track) => track.stop());
    }
};

/**
 * Loads the screenshot target preference from storage.
 */
const loadScreenshotTargetPreference = async () => {
    if (!screenshotTargetSelect) return;

    const result = await chrome.storage.local.get(["screenshotTarget"]);
    screenshotTargetSelect.value = result.screenshotTarget || "tab";
    updateCaptureOptionUI();
};

/**
 * Saves the screenshot target preference to storage.
 */
const saveScreenshotTargetPreference = async () => {
    if (!screenshotTargetSelect) return;

    const target = screenshotTargetSelect.value || "tab";
    await chrome.storage.local.set({ screenshotTarget: target });
    updateCaptureOptionUI();
};

/**
 * Updates copy and toggle availability based on the selected screenshot target.
 */
const updateCaptureOptionUI = () => {
    const target = screenshotTargetSelect?.value || "tab";
    const isTabCapture = target === "tab";

    if (captureHint) {
        captureHint.textContent = isTabCapture
            ? "Tab capture includes page context when available."
            : "Window and screen capture use the system share picker and save only the captured image.";
    }

    if (networkCaptureToggle) {
        networkCaptureToggle.disabled = !isTabCapture;
    }
};



/**
 * Retrieves the active browser tab.
 * @returns {Promise<chrome.tabs.Tab|null>} - The active tab object or null if unsupported.
 */
const getActiveBrowserTab = async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) return null;
    const tab = tabs[0];
    // Check if URL is accessible
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:'))) {
        return null;
    }
    return tab;
};

/**
 * Executes a script in the active tab.
 * @param {Object} options - The script options.
 * @returns {Promise<void>}
 */
const executeScriptInTab = async (options) => {
    const activeTab = await getActiveBrowserTab();
    if (!activeTab) {
        console.log('Cannot execute script: unsupported tab URL');
        return;
    }
    options.target = { tabId: activeTab.id };
    await chrome.scripting.executeScript(options);
};



/**
 * Checks the recording status from Chrome storage.
 * @returns {Promise<{ recording: boolean, type: string }>} - The recording status and type.
 */
const getRecordingStatus = async () => {
    const { recording = false, type = "" } = await chrome.storage.local.get(["recording", "type"]);
    return { recording, type };
};

/**
 * Updates the recording status in Chrome storage.
 * @param {boolean} isRecording - Whether recording is active.
 * @param {string} [recordingType=""] - The type of recording (e.g., 'tab', 'screen').
 * @returns {Promise<void>}
 */
const updateRecordingStatus = async (isRecording, recordingType = "") => {
    await chrome.storage.local.set({ recording: isRecording, type: recordingType });
};

/**
 * Updates the UI state based on the current recording and toggle states.
 */
const updateUIState = async () => {
    try {
        const { recording, type } = await getRecordingStatus();

        if (recordTabButton) {
            recordTabButton.innerText = recording && type === "tab" ? "Stop Recording" : "Record Tab";
        }
        if (recordScreenButton) {
            recordScreenButton.innerText = recording && type === "screen" ? "Stop Recording" : "Record Screen";
        }
    } catch (error) {
        console.log('Could not update UI state:', error.message);
    }
};

/**
 * Toggles recording state based on the current status.
 * @param {string} recordingType - The type of recording to toggle ('tab' or 'screen').
 */
const toggleRecordingState = async (recordingType) => {
    const { recording } = await getRecordingStatus();

    if (recording) {
        chrome.runtime.sendMessage({ type: "stop-recording" });
    } else {
        chrome.runtime.sendMessage({ type: "start-recording", recordingType });
    }

    await updateUIState();
    window.close();
};

/**
 * Updates the authentication UI based on current auth state.
 */
const updateAuthUI = async () => {
    try {
        const authenticated = await isAuthenticated();
        
        if (authenticated) {
            const user = await getCurrentUser();
            if (user) {
                userName.textContent = user.fullName || user.firstName || 'User';
                userEmail.textContent = user.primaryEmailAddress?.emailAddress || '';
                signedInView.style.display = 'block';
                signedOutView.style.display = 'none';
            }
        } else {
            signedInView.style.display = 'none';
            signedOutView.style.display = 'block';
        }
    } catch (error) {
        console.error('Error updating auth UI:', error);
        signedInView.style.display = 'none';
        signedOutView.style.display = 'block';
    }
};

/**
 * Initializes the popup UI and event listeners.
 */
const initializePopup = async () => {
    try {
        await updateUIState();
        await updateAuthUI();

        signInGoogleBtn.addEventListener("click", async () => {
            try {
                await signInWithGoogle();
                await updateAuthUI();
            } catch (error) {
                console.error('Google sign in error:', error);
            }
        });

        syncAuthBtn.addEventListener("click", async () => {
            try {
                syncAuthBtn.textContent = '🔄 Syncing...';
                syncAuthBtn.disabled = true;
                await syncClerkSession();
                await updateAuthUI();
                syncAuthBtn.textContent = '✅ Synced!';
                setTimeout(() => {
                    syncAuthBtn.textContent = '🔄 Sync Session';
                    syncAuthBtn.disabled = false;
                }, 2000);
            } catch (error) {
                console.error('Sync error:', error);
                syncAuthBtn.textContent = '❌ Sync failed';
                setTimeout(() => {
                    syncAuthBtn.textContent = '🔄 Sync Session';
                    syncAuthBtn.disabled = false;
                }, 2000);
            }
        });

        signOutBtn.addEventListener("click", async () => {
            try {
                await signOut();
                await updateAuthUI();
            } catch (error) {
                console.error('Sign out error:', error);
            }
        });

        libraryBtn.addEventListener("click", async () => {
            try {
                const config = await getRuntimeConfig();
                chrome.tabs.create({ url: `${config.siteUrl}/#/library` });
            } catch (error) {
                console.error('Library URL error:', error);
            }
        });

        // Listen for auth changes
        onAuthChange(async (authenticated) => {
            await updateAuthUI();
        });

        // Only add listeners if buttons exist (they might be commented out in HTML)
        if (recordScreenButton) {
            recordScreenButton.addEventListener("click", () => toggleRecordingState("screen"));
        }
        if (recordTabButton) {
            recordTabButton.addEventListener("click", () => toggleRecordingState("tab"));
        }
        if (screenshotButton) {
            screenshotButton.addEventListener("click", async () => {
                const captureTarget = screenshotTargetSelect?.value || "tab";

                console.log("Screenshot button clicked", { captureTarget });

                try {
                    if (captureTarget === "window" || captureTarget === "screen") {
                        await captureDesktopScreenshot(captureTarget);
                    } else {
                        await chrome.runtime.sendMessage({
                            type: "take-screenshot",
                            target: "service-worker",
                            captureTarget,
                        });
                    }

                    console.log("Message sent to service worker");
                    window.close();
                } catch (error) {
                    console.error("Failed to start screenshot capture:", error);
                }
            });
        }

        if (screenshotTargetSelect) {
            await loadScreenshotTargetPreference();
            screenshotTargetSelect.addEventListener("change", saveScreenshotTargetPreference);
        }

        // Mode toggle (if exists)
        if (modeToggleSwitch) {
            modeToggleSwitch.addEventListener("change", toggleThemeMode);
        }
        
        // Network capture toggle (if exists)
        if (networkCaptureToggle) {
            loadNetworkCapturePreference();
            networkCaptureToggle.addEventListener("change", saveNetworkCapturePreference);
        }

        // Full page screenshot toggle (if exists)
        if (fullPageToggle) {
            loadFullPagePreference();
            fullPageToggle.addEventListener("change", saveFullPagePreference);
        }
    } catch (error) {
        console.error("[Popup Initialization] Error:", error);
    }
};

if (modeToggleSwitch && modeLabelElement) {
    setDefaultThemeMode();
}
initializePopup();
