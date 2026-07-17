import { saveCapture } from './db.js';

// Shared media-capture helpers used by the offscreen document (tab recordings)
// and the desktop-capture window (screen/window screenshots and recordings).
// Desktop streamIds from desktopCapture.chooseDesktopMedia can only be consumed
// by the page that requested them, so desktop capture must run in that window —
// see https://issues.chromium.org/issues/41493089.

/**
 * Gets the video (+ audio where available) stream for a tab or desktop capture.
 * @param {string} streamId
 * @param {"tab"|"desktop"} source
 * @returns {Promise<MediaStream>}
 */
export async function getCaptureStream (streamId, source) {
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
        console.warn("Capture with audio failed, retrying video-only:", error.message);
        return navigator.mediaDevices.getUserMedia({ ...constraints, audio: false });
    }
}

/**
 * Gets the media stream for the microphone.
 * @returns {Promise<MediaStream>} - The media stream for the microphone.
 */
export async function getMicrophoneStream () {
    return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false },
    });
}

/**
 * Mixes whatever audio sources are available (capture audio, microphone)
 * into a single stream alongside the capture's video track.
 * @returns {{combinedStream: MediaStream, audioContext: AudioContext | null}}
 */
export function combineMediaStreams (captureStream, micStream) {
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
 * Persists a finished recording and asks the service worker to open the preview.
 * @param {Blob[]} recordedChunks
 * @param {"tab"|"desktop"} source
 * @returns {Promise<string>} - The capture id of the saved recording.
 */
export async function saveRecording (recordedChunks, source) {
    const recordedBlob = new Blob(recordedChunks, { type: "video/webm" });

    // Generate filename with timestamp; the "screen-"/"tab-" prefix is what
    // classifies the capture type at upload time.
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `${source === "desktop" ? "screen" : "tab"}-recording-${timestamp}.webm`;

    const captureId = crypto.randomUUID();
    await saveCapture(captureId, recordedBlob, filename, 'video/webm');

    // Message service worker to open preview tab
    chrome.runtime.sendMessage({
        type: 'open-preview',
        id: captureId,
        captureType: 'video'
    });

    return captureId;
}

const withTimeout = (promise, timeoutMs, message, onLateResolve = null) => (
    new Promise((resolve, reject) => {
        let settled = false;
        const timeoutId = setTimeout(() => {
            settled = true;
            reject(new Error(message));
        }, timeoutMs);

        Promise.resolve(promise).then((value) => {
            if (settled) {
                onLateResolve?.(value);
                return;
            }
            settled = true;
            clearTimeout(timeoutId);
            resolve(value);
        }, (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutId);
            reject(error);
        });
    })
);

const waitForVideoMetadata = (video, videoTrack, timeoutMs = 5000) => {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => finish(new Error('Timed out waiting for desktop video metadata')), timeoutMs);
        const onLoadedMetadata = () => finish();
        const onVideoError = () => finish(new Error('Desktop video could not load metadata'));
        const onTrackEnded = () => finish(new Error('The selected screen or window stopped sharing'));

        const cleanup = () => {
            clearTimeout(timeoutId);
            video.removeEventListener('loadedmetadata', onLoadedMetadata);
            video.removeEventListener('error', onVideoError);
            videoTrack.removeEventListener('ended', onTrackEnded);
        };
        const finish = (error = null) => {
            cleanup();
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };

        video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
        video.addEventListener('error', onVideoError, { once: true });
        videoTrack.addEventListener('ended', onTrackEnded, { once: true });
    });
};

const waitForVideoFrame = (video, videoTrack, timeoutMs = 3000) => (
    new Promise((resolve, reject) => {
        let frameCallbackId = null;
        let fallbackTimerId = null;
        const timeoutId = setTimeout(() => finish(new Error('Timed out waiting for a desktop video frame')), timeoutMs);
        const onVideoError = () => finish(new Error('Desktop video failed before its first frame'));
        const onTrackEnded = () => finish(new Error('The selected screen or window stopped sharing'));

        const cleanup = () => {
            clearTimeout(timeoutId);
            if (fallbackTimerId !== null) {
                clearTimeout(fallbackTimerId);
            }
            if (frameCallbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
                video.cancelVideoFrameCallback(frameCallbackId);
            }
            video.removeEventListener('error', onVideoError);
            videoTrack.removeEventListener('ended', onTrackEnded);
        };
        const finish = (error = null) => {
            cleanup();
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };

        video.addEventListener('error', onVideoError, { once: true });
        videoTrack.addEventListener('ended', onTrackEnded, { once: true });
        if (typeof video.requestVideoFrameCallback === 'function') {
            frameCallbackId = video.requestVideoFrameCallback(() => finish());
        } else {
            fallbackTimerId = setTimeout(() => finish(), 150);
        }
    })
);

/**
 * Captures a still image from a desktop or window stream and saves it locally.
 * @param {string} streamId
 * @returns {Promise<{ success: boolean, captureId: string, filename: string, mimeType: string, source: string, deviceMeta: object }>}
 */
export async function captureDesktopScreenshot (streamId) {
    let stream = null;
    let video = null;

    try {
        const mediaRequest = navigator.mediaDevices.getUserMedia({
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
        stream = await withTimeout(
            mediaRequest,
            10000,
            'Timed out opening the selected screen or window',
            (lateStream) => lateStream?.getTracks().forEach((track) => track.stop())
        );

        const [videoTrack] = stream.getVideoTracks();
        if (!videoTrack) {
            throw new Error("No video track found for desktop screenshot");
        }

        const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
        const displaySurface = settings.displaySurface || "screen";
        const source = displaySurface === 'window' ? 'window' : 'screen';
        video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;

        await waitForVideoMetadata(video, videoTrack);
        await withTimeout(video.play(), 5000, 'Timed out starting desktop video playback');
        await waitForVideoFrame(video, videoTrack);

        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) {
            throw new Error('The selected screen or window returned an empty video frame');
        }

        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("Could not create canvas context");
        }

        context.drawImage(video, 0, 0, width, height);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const captureId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        const filenameTimestamp = timestamp.replace(/[:.]/g, '-').slice(0, -5);
        const filename = `${source}-screenshot-${filenameTimestamp}.png`;
        const deviceMeta = {
            captureSurface: "display",
            displaySurface,
            screenWidth: width,
            screenHeight: height,
            timestamp,
        };

        await saveCapture(captureId, blob, filename, 'image/png', null, null, null, deviceMeta);

        return {
            success: true,
            captureId,
            filename,
            mimeType: 'image/png',
            source,
            deviceMeta,
        };
    } finally {
        if (video) {
            video.pause();
            video.srcObject = null;
        }
        stream?.getTracks().forEach((track) => track.stop());
    }
}
