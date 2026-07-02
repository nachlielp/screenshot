import { saveCapture } from './utils/db.js';

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
 * Gets the video (+ audio where available) stream for a tab or desktop capture.
 * @param {string} streamId
 * @param {"tab"|"desktop"} source
 * @returns {Promise<MediaStream>}
 */
async function getCaptureStream (streamId, source) {
    const isDesktop = source === "desktop";
    const constraints = {
        audio: {
            mandatory: {
                chromeMediaSource: source,
                chromeMediaSourceId: streamId,
            },
        },
        video: {
            mandatory: {
                chromeMediaSource: source,
                chromeMediaSourceId: streamId,
                maxWidth: isDesktop ? 3840 : 1920,
                maxHeight: isDesktop ? 2160 : 1080,
                maxFrameRate: 30,
            },
        },
    };

    try {
        return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
        // Some desktop surfaces refuse audio capture — retry video-only
        console.warn("[offscreen] Capture with audio failed, retrying video-only:", error.message);
        return navigator.mediaDevices.getUserMedia({ ...constraints, audio: false });
    }
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
 * Mixes whatever audio sources are available (capture audio, microphone)
 * into a single stream alongside the capture's video track.
 * @returns {{combinedStream: MediaStream, audioContext: AudioContext | null}}
 */
function combineMediaStreams (captureStream, micStream) {
    const videoTrack = captureStream.getVideoTracks()[0];
    const audioSources = [captureStream, micStream].filter(
        (stream) => stream && stream.getAudioTracks().length > 0
    );

    if (audioSources.length === 0) {
        return { combinedStream: new MediaStream([videoTrack]), audioContext: null };
    }

    const audioContext = new AudioContext();
    const audioDestination = audioContext.createMediaStreamDestination();
    for (const stream of audioSources) {
        audioContext.createMediaStreamSource(stream).connect(audioDestination);
    }

    const combinedStream = new MediaStream([
        videoTrack,
        audioDestination.stream.getTracks()[0],
    ]);

    return { combinedStream, audioContext };
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
    const recordedBlob = new Blob(recordedChunks, { type: "video/webm" });

    // Generate filename with timestamp; the "screen-"/"tab-" prefix is what
    // classifies the capture type at upload time.
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `${recordingSource === "desktop" ? "screen" : "tab"}-recording-${timestamp}.webm`;
    
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
