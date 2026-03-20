import { isAuthenticated, getCurrentUser, signInWithGoogle, signOut, onAuthChange, syncClerkSession } from './utils/auth.js';
import { getRuntimeConfig } from './utils/runtime-config.js';
import { saveCapture } from './utils/db.js';

const visiblePartBtn = document.getElementById("visiblePartBtn");
const tabWithLogsBtn = document.getElementById("tabWithLogsBtn");
const fullPageBtn = document.getElementById("fullPageBtn");
const delayedTabBtn = document.getElementById("delayedTabBtn");
const screenWindowBtn = document.getElementById("screenWindowBtn");
const annotateImageBtn = document.getElementById("annotateImageBtn");
const signInGoogleBtn = document.getElementById("signInGoogleBtn");
const syncAuthBtn = document.getElementById("syncAuthBtn");
const signOutBtn = document.getElementById("signOutBtn");
const libraryBtn = document.getElementById("libraryBtn");
const userName = document.getElementById("userName");
const userEmail = document.getElementById("userEmail");

const DELAY_MS = 3000;
const POPUP_HIDE_SETTLE_MS = 75;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const canvasToBlob = (canvas) => (
    new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Failed to create screenshot blob'));
                return;
            }

            resolve(blob);
        }, 'image/png');
    })
);

const setButtonBusy = (button, busy) => {
    if (!button) return;
    button.disabled = busy;
};

const setDelayBadge = (button, label) => {
    const badge = button?.querySelector('.delay-pill');
    if (badge) {
        badge.textContent = label;
    }
};

const runCountdown = async (button, seconds) => {
    if (!button) return;

    button.classList.add('counting-down');
    setButtonBusy(button, true);

    for (let remaining = seconds; remaining >= 1; remaining -= 1) {
        setDelayBadge(button, `${remaining}s`);
        await sleep(1000);
    }
};

const resetCountdown = (button) => {
    if (!button) return;
    button.classList.remove('counting-down');
    setButtonBusy(button, false);
    setDelayBadge(button, '3s');
};

const chooseDesktopMedia = () => (
    new Promise((resolve, reject) => {
        chrome.desktopCapture.chooseDesktopMedia(['screen', 'window'], (streamId) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }

            if (!streamId) {
                reject(new Error('Desktop capture was cancelled'));
                return;
            }

            resolve(streamId);
        });
    })
);

const hidePopupForCapture = () => {
    const htmlStyle = document.documentElement.getAttribute('style');
    const bodyStyle = document.body.getAttribute('style');
    const childVisibility = Array.from(document.body.children).map((element) => ({
        element,
        visibility: element.style.visibility,
    }));

    document.documentElement.style.setProperty('width', '1px', 'important');
    document.documentElement.style.setProperty('height', '1px', 'important');
    document.documentElement.style.setProperty('min-width', '1px', 'important');
    document.documentElement.style.setProperty('min-height', '1px', 'important');
    document.documentElement.style.setProperty('overflow', 'hidden', 'important');
    document.documentElement.style.setProperty('opacity', '0', 'important');
    document.documentElement.style.setProperty('background', 'transparent', 'important');
    document.documentElement.style.setProperty('pointer-events', 'none', 'important');

    document.body.style.setProperty('width', '1px', 'important');
    document.body.style.setProperty('height', '1px', 'important');
    document.body.style.setProperty('min-width', '1px', 'important');
    document.body.style.setProperty('min-height', '1px', 'important');
    document.body.style.setProperty('margin', '0', 'important');
    document.body.style.setProperty('overflow', 'hidden', 'important');
    document.body.style.setProperty('opacity', '0', 'important');
    document.body.style.setProperty('background', 'transparent', 'important');
    document.body.style.setProperty('pointer-events', 'none', 'important');

    childVisibility.forEach(({ element }) => {
        element.style.visibility = 'hidden';
    });

    try {
        window.resizeTo(1, 1);
    } catch (error) {
        console.debug('Popup resize is not available:', error);
    }

    return () => {
        if (htmlStyle === null) {
            document.documentElement.removeAttribute('style');
        } else {
            document.documentElement.setAttribute('style', htmlStyle);
        }

        if (bodyStyle === null) {
            document.body.removeAttribute('style');
        } else {
            document.body.setAttribute('style', bodyStyle);
        }

        childVisibility.forEach(({ element, visibility }) => {
            element.style.visibility = visibility;
        });
    };
};

const captureDisplayScreenshot = async () => {
    const streamId = await chooseDesktopMedia();
    const restorePopup = hidePopupForCapture();
    await sleep(POPUP_HIDE_SETTLE_MS);
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
            mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: streamId,
                maxWidth: 3840,
                maxHeight: 2160,
                maxFrameRate: 30,
            },
        },
    });

    try {
        const [videoTrack] = stream.getVideoTracks();
        if (!videoTrack) {
            throw new Error('No video track found for display capture');
        }

        const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;

        await new Promise((resolve) => {
            video.onloadedmetadata = () => resolve();
        });
        await video.play();

        if (typeof video.requestVideoFrameCallback === 'function') {
            await new Promise((resolve) => video.requestVideoFrameCallback(() => resolve()));
        } else {
            await sleep(150);
        }

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Could not create canvas context');
        }

        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        const blob = await canvasToBlob(canvas);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const captureId = crypto.randomUUID();
        const displaySurface = settings.displaySurface || 'display';
        const filename = `${displaySurface}-screenshot-${timestamp}.png`;

        await saveCapture(captureId, blob, filename, 'image/png', null, null, null, {
            captureSurface: 'display',
            displaySurface,
            screenWidth: canvas.width,
            screenHeight: canvas.height,
            timestamp: new Date().toISOString(),
        });

        const editorUrl = chrome.runtime.getURL(`editor.html?id=${captureId}`);
        await chrome.tabs.create({ url: editorUrl });
    } catch (error) {
        restorePopup();
        throw error;
    } finally {
        stream.getTracks().forEach((track) => track.stop());
    }
};

const takeTabScreenshot = async ({ includeLogs, fullPage, delayMs = 0 }) => {
    if (delayMs > 0) {
        await sleep(delayMs);
    }

    await chrome.runtime.sendMessage({
        type: "take-screenshot",
        target: "service-worker",
        captureTarget: "tab",
        includeLogs,
        fullPage,
    });
};

const openAnnotateImport = async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('import-image.html') });
};

const updateAuthUI = async () => {
    try {
        const authenticated = await isAuthenticated();

        if (authenticated) {
            const user = await getCurrentUser();
            userName.textContent = user?.fullName || user?.firstName || 'Signed in';
            userEmail.textContent = user?.primaryEmailAddress?.emailAddress || 'Ready to share captures';
            signOutBtn.style.display = 'inline-flex';
            signInGoogleBtn.style.display = 'none';
        } else {
            userName.textContent = 'Not signed in';
            userEmail.textContent = 'Sign in to share your captures';
            signOutBtn.style.display = 'none';
            signInGoogleBtn.style.display = 'inline-flex';
        }
    } catch (error) {
        console.error('Error updating auth UI:', error);
        userName.textContent = 'Not signed in';
        userEmail.textContent = 'Sign in to share your captures';
        signOutBtn.style.display = 'none';
        signInGoogleBtn.style.display = 'inline-flex';
    }
};

const initializePopup = async () => {
    try {
        await updateAuthUI();

        visiblePartBtn?.addEventListener("click", async () => {
            await takeTabScreenshot({ includeLogs: false, fullPage: false });
            window.close();
        });

        tabWithLogsBtn?.addEventListener("click", async () => {
            await takeTabScreenshot({ includeLogs: true, fullPage: false });
            window.close();
        });

        fullPageBtn?.addEventListener("click", async () => {
            await takeTabScreenshot({ includeLogs: false, fullPage: true });
            window.close();
        });

        delayedTabBtn?.addEventListener("click", async () => {
            try {
                await runCountdown(delayedTabBtn, DELAY_MS / 1000);
                await takeTabScreenshot({ includeLogs: false, fullPage: false });
                window.close();
            } catch (error) {
                console.error("Delayed tab capture failed:", error);
                resetCountdown(delayedTabBtn);
            }
        });

        screenWindowBtn?.addEventListener("click", async () => {
            try {
                await captureDisplayScreenshot();
                window.close();
            } catch (error) {
                console.error("Display capture failed:", error);
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

        syncAuthBtn?.addEventListener("click", async () => {
            try {
                setButtonBusy(syncAuthBtn, true);
                syncAuthBtn.textContent = 'Syncing...';
                await syncClerkSession();
                await updateAuthUI();
            } catch (error) {
                console.error('Sync error:', error);
            } finally {
                syncAuthBtn.textContent = 'Sync';
                setButtonBusy(syncAuthBtn, false);
            }
        });

        signOutBtn?.addEventListener("click", async () => {
            try {
                await signOut();
                await updateAuthUI();
            } catch (error) {
                console.error('Sign out error:', error);
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
