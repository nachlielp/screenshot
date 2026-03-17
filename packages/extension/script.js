import { isAuthenticated, getCurrentUser, signIn, signInWithGoogle, signOut, onAuthChange, syncClerkSession } from './utils/auth.js';
import { getRuntimeConfig } from './utils/runtime-config.js';

/**
 * Cache DOM elements for easy access.
 */
const recordTabButton = document.getElementById("tab");
const recordScreenButton = document.getElementById("screen");
const screenshotButton = document.getElementById("screenshot");
const bodyElement = document.body;
const modeToggleSwitch = document.getElementById("modeToggle");
const modeLabelElement = document.getElementById("modeLabel");
const htmlCaptureToggle = document.getElementById("htmlCaptureToggle");
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
 * Loads the HTML capture preference from storage
 */
const loadHtmlCapturePreference = async () => {
    const result = await chrome.storage.local.get(["htmlCaptureEnabled"]);
    const isEnabled = result.htmlCaptureEnabled === true; // Default to false
    htmlCaptureToggle.checked = isEnabled;
};

/**
 * Saves the HTML capture preference to storage
 */
const saveHtmlCapturePreference = async () => {
    const isEnabled = htmlCaptureToggle.checked;
    await chrome.storage.local.set({ htmlCaptureEnabled: isEnabled });
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
                console.log("Screenshot button clicked");
                chrome.runtime.sendMessage({ type: "take-screenshot" });
                console.log("Message sent to service worker");
                window.close();
            });
        }

        // Mode toggle (if exists)
        if (modeToggleSwitch) {
            modeToggleSwitch.addEventListener("change", toggleThemeMode);
        }
        
        // HTML capture toggle (if exists)
        if (htmlCaptureToggle) {
            loadHtmlCapturePreference();
            htmlCaptureToggle.addEventListener("change", saveHtmlCapturePreference);
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
