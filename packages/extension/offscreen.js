import {
    getCaptureStream,
    getMicrophoneStream,
    combineMediaStreams,
    saveRecording,
} from './utils/media-capture.js';

// The offscreen document only handles tab recordings. Desktop (screen/window)
// capture runs in the desktop-capture window instead, because streamIds from
// desktopCapture.chooseDesktopMedia can only be consumed by the page that
// requested them — consuming one here fails with "Error starting tab capture".

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only handle messages explicitly addressed to the offscreen document.
    // Untargeted start/stop-recording broadcasts come from the popup and are
    // meant for the service worker — handling them here raced the real
    // recording and could kill its tracks.
    if (message.target !== "offscreen") {
        return false;
    }

    switch (message.type) {
        case "offscreen-ping":
            sendResponse({ success: true });
            return false;
        case "start-recording":
            startRecording(message.data, message.source || "tab")
                .then(() => sendResponse({ success: true }))
                .catch((error) => sendResponse({ success: false, error: error.message }));
            return true;
        case "stop-recording":
            stopRecording()
                .then(() => sendResponse({ success: true }))
                .catch((error) => sendResponse({ success: false, error: error.message }));
            return true;
        default:
            console.warn("Unknown request type:", message.type);
    }
    return false;
});

let mediaRecorder = null;
let recordedChunks = [];
let recordingSource = "tab";
// Resources owned by the active recording; released by releaseRecordingResources().
let recordingResources = { tabStream: null, micStream: null, audioContext: null };

function releaseRecordingResources() {
    const { tabStream, micStream, audioContext } = recordingResources;
    tabStream?.getTracks().forEach((track) => track.stop());
    micStream?.getTracks().forEach((track) => track.stop());
    if (audioContext && audioContext.state !== "closed") {
        audioContext.close().catch(() => {});
    }
    recordingResources = { tabStream: null, micStream: null, audioContext: null };
}

/**
 * Stops the recording and handles the cleanup.
 */
async function stopRecording () {
    console.log("[offscreen] Stopping recording");

    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        releaseRecordingResources();
        throw new Error("No recording is in progress");
    }

    try {
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach((track) => track.stop());
    } finally {
        releaseRecordingResources();
        await stopTabCapture().catch((error) => {
            console.warn("[offscreen] Error stopping tab capture:", error);
        });
    }
}

/**
 * Stops the tab capture session if active.
 */
async function stopTabCapture () {
    try {
        const stream = await chrome.tabCapture.getCapturedTabs();
        if (stream && stream.length > 0) {
            stream[0].getTracks().forEach((track) => track.stop());
        }
    } catch (error) {
        throw new Error("[offscreen] Error stopping tab capture:", error);
    }
}

/**
 * Starts recording a tab or desktop stream.
 * @param {string} streamId - Stream id from tabCapture.getMediaStreamId or
 *   desktopCapture.chooseDesktopMedia.
 * @param {"tab"|"desktop"} source - Which chromeMediaSource the id belongs to.
 */
async function startRecording (streamId, source = "tab") {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        throw new Error("Recording is already in progress");
    }

    recordedChunks = [];
    recordingSource = source;
    let captureStream = null;
    let micStream = null;

    try {
        captureStream = await getCaptureStream(streamId, source);
        // The microphone is best-effort — record without narration if denied
        micStream = await getMicrophoneStream().catch((error) => {
            console.warn("[offscreen] Microphone unavailable, recording without it:", error.message);
            return null;
        });

        const { combinedStream, audioContext } = combineMediaStreams(captureStream, micStream);
        recordingResources = { tabStream: captureStream, micStream, audioContext };

        mediaRecorder = new MediaRecorder(combinedStream, {
            mimeType: "video/webm",
            videoBitsPerSecond: 5000000,
        });

        mediaRecorder.ondataavailable = handleDataAvailable;
        mediaRecorder.onstop = handleRecordingStop;

        mediaRecorder.start();
    } catch (error) {
        captureStream?.getTracks().forEach((track) => track.stop());
        micStream?.getTracks().forEach((track) => track.stop());
        releaseRecordingResources();
        mediaRecorder = null;
        console.error("[offscreen] Error starting recording:", error);
        throw error;
    }
}

/**
 * Handles the `ondataavailable` event for the MediaRecorder.
 * @param {BlobEvent} event - The event containing the recorded data.
 */
function handleDataAvailable (event) {
    recordedChunks.push(event.data);
}

/**
 * Handles the `onstop` event for the MediaRecorder.
 */
async function handleRecordingStop () {
    mediaRecorder = null;
    await saveRecording(recordedChunks, recordingSource);
    recordedChunks = [];
}
