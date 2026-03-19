import { saveCapture } from './utils/db.js';

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target && message.target !== "offscreen") {
        return false;
    }

    if (!message.target && !["start-recording", "stop-recording", "capture-desktop-screenshot"].includes(message.type)) {
        return false;
    }

    switch (message.type) {
        case "start-recording":
            startRecording(message.data);
            break;
        case "stop-recording":
            stopRecording();
            break;
        case "capture-desktop-screenshot":
            captureDesktopScreenshot(message.streamId, message.captureTarget)
                .then((result) => sendResponse(result))
                .catch((error) => {
                    sendResponse({
                        success: false,
                        error: error.message,
                    });
                });
            return true;
        default:
            console.warn("Unknown request type:", message.type);
    }
    return false;
});

let mediaRecorder = null;
let recordedChunks = [];

/**
 * Stops the recording and handles the cleanup.
 */
async function stopRecording () {
    console.log("[offscreen] Stopping recording");

    if (mediaRecorder?.state === "recording") {
        mediaRecorder.stop();

        mediaRecorder.stream.getTracks().forEach((track) => track.stop());
    }
    await stopTabCapture();
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
 * Starts the recording process for the provided stream ID.
 * @param {string} streamId - The stream ID for the tab to be recorded.
 */
async function startRecording (streamId) {
    try {
        if (mediaRecorder?.state === "recording") {
            throw new Error("[offscreen] Recording is already in progress.");
        }

        // Create media streams for tab capture and microphone
        const tabStream = await getTabMediaStream(streamId);
        const micStream = await getMicrophoneStream();

        // Combine tab and microphone streams
        const combinedStream = combineMediaStreams(tabStream, micStream);

        mediaRecorder = new MediaRecorder(combinedStream, {
            mimeType: "video/webm",
            videoBitsPerSecond: 5000000,
        });

        mediaRecorder.ondataavailable = handleDataAvailable;
        mediaRecorder.onstop = handleRecordingStop;

        mediaRecorder.start();
    } catch (error) {
        console.error("[offscreen] Error starting recording:", error);
    }
}

/**
 * Gets the media stream for the tab being captured.
 * @param {string} streamId - The stream ID for the tab.
 * @returns {Promise<MediaStream>} - The media stream for the tab.
 */

async function getTabMediaStream (streamId) {
    return navigator.mediaDevices.getUserMedia({
        audio: {
            mandatory: {
                chromeMediaSource: "tab",
                chromeMediaSourceId: streamId,
            },
        },
        video: {
            mandatory: {
                chromeMediaSource: "tab",
                chromeMediaSourceId: streamId,
                maxWidth: 1920,
                maxHeight: 1080,
                maxFrameRate: 30,
            },
        },
    });
}

/**
 * Gets the media stream for the microphone.
 * @returns {Promise<MediaStream>} - The media stream for the microphone.
 */

async function getMicrophoneStream () {
    return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false },
    });
}

/**
 * Combines the tab and microphone media streams.
 * @param {MediaStream} tabStream - The media stream for the tab.
 * @param {MediaStream} micStream - The media stream for the microphone.
 * @returns {MediaStream} - The combined media stream.
 */
function combineMediaStreams (tabStream, micStream) {
    const audioContext = new AudioContext();
    const audioDestination = audioContext.createMediaStreamDestination();

    audioContext.createMediaStreamSource(micStream).connect(audioDestination);
    audioContext.createMediaStreamSource(tabStream).connect(audioDestination);

    return new MediaStream([
        tabStream.getVideoTracks()[0],
        audioDestination.stream.getTracks()[0],
    ]);
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
    const recordedBlob = new Blob(recordedChunks, { type: "video/webm" });
    
    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `recording-${timestamp}.webm`;
    
    // Save to IndexedDB with unique ID
    const captureId = crypto.randomUUID();
    await saveCapture(captureId, recordedBlob, filename, 'video/webm');
    
    // Message service worker to open preview tab
    chrome.runtime.sendMessage({
        type: 'open-preview',
        id: captureId,
        captureType: 'video'
    });
    
    recordedChunks = [];
}

/**
 * Captures a still image from a desktop or window stream.
 * @param {string} streamId
 * @param {"screen"|"window"} captureTarget
 * @returns {Promise<{ success: boolean, dataUrl: string, deviceMeta: object }>}
 */
async function captureDesktopScreenshot (streamId, captureTarget) {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
            mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: streamId,
                maxWidth: 7680,
                maxHeight: 4320,
            },
        },
    });

    try {
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

        const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
        const context = canvas.getContext("2d");

        if (!context) {
            throw new Error("Could not create canvas context");
        }

        context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);

        const blob = await canvas.convertToBlob({ type: "image/png" });
        const dataUrl = await blobToDataUrl(blob);

        return {
            success: true,
            dataUrl,
            deviceMeta: {
                captureSurface: captureTarget,
                screenWidth: video.videoWidth,
                screenHeight: video.videoHeight,
                timestamp: new Date().toISOString(),
            },
        };
    } finally {
        stream.getTracks().forEach((track) => track.stop());
    }
}

/**
 * Converts a blob into a data URL.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl (blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });
}
