import { requestRuntime } from './utils/messaging.js';
import {
    captureDesktopScreenshot,
    getCaptureStream,
    getMicrophoneStream,
    combineMediaStreams,
    saveRecording,
} from './utils/media-capture.js';

// Desktop streamIds from desktopCapture.chooseDesktopMedia can only be
// consumed by the page that requested them, so both the screenshot and the
// screen recording run in this window (not the offscreen document).

const title = document.getElementById('title');
const status = document.getElementById('status');
const chooseBtn = document.getElementById('chooseBtn');
const cancelBtn = document.getElementById('cancelBtn');

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') || 'screenshot';
const slideshowSessionId = params.get('slideshowSessionId') || null;
const isRecording = mode === 'recording';

if (!['screenshot', 'recording'].includes(mode)) {
    throw new Error(`Unsupported desktop capture mode: ${mode}`);
}

const setStatus = (message, state = 'idle') => {
    status.textContent = message;
    status.dataset.state = state;
};

const chooseDesktopMedia = () => (
    new Promise((resolve, reject) => {
        chrome.desktopCapture.chooseDesktopMedia(['screen', 'window'], (streamId) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(streamId || null);
        });
    })
);

const takeDesktopScreenshot = async (streamId) => {
    const capture = await captureDesktopScreenshot(streamId);
    await requestRuntime({
        type: 'desktop-screenshot-complete',
        target: 'service-worker',
        capture,
        slideshowSessionId,
    }, { timeoutMs: 15000 });
};

// --- Screen recording (owned by this window; closing it ends the recording) ---

let mediaRecorder = null;
let recordedChunks = [];
let recordingResources = { captureStream: null, micStream: null, audioContext: null };

const releaseRecordingResources = () => {
    const { captureStream, micStream, audioContext } = recordingResources;
    captureStream?.getTracks().forEach((track) => track.stop());
    micStream?.getTracks().forEach((track) => track.stop());
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(() => {});
    }
    recordingResources = { captureStream: null, micStream: null, audioContext: null };
};

const handleRecordingStop = async () => {
    mediaRecorder = null;
    releaseRecordingResources();

    try {
        setStatus('Saving recording…');
        await saveRecording(recordedChunks, 'desktop');
        setStatus('Recording saved.', 'success');
    } catch (error) {
        console.error('Failed to save recording:', error);
        setStatus(`Failed to save recording: ${error.message}. Choose again to start over.`, 'error');
        title.textContent = 'Record a screen or window';
        chooseBtn.textContent = 'Choose screen or window';
        chooseBtn.disabled = false;
        cancelBtn.hidden = false;
        return;
    } finally {
        recordedChunks = [];
        await requestRuntime({
            type: 'desktop-recording-stopped',
            target: 'service-worker',
        }).catch((error) => console.warn('Failed to report recording stop:', error));
    }

    setTimeout(() => window.close(), 400);
};

const stopScreenRecording = () => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        return false;
    }
    chooseBtn.disabled = true;
    mediaRecorder.stop();
    return true;
};

const startScreenRecording = async (streamId) => {
    let captureStream = null;
    let micStream = null;

    try {
        captureStream = await getCaptureStream(streamId, 'desktop');
        // The microphone is best-effort — record without narration if denied
        micStream = await getMicrophoneStream().catch((error) => {
            console.warn('Microphone unavailable, recording without it:', error.message);
            return null;
        });

        const { combinedStream, audioContext } = combineMediaStreams(captureStream, micStream);
        recordingResources = { captureStream, micStream, audioContext };
        recordedChunks = [];

        mediaRecorder = new MediaRecorder(combinedStream, {
            mimeType: 'video/webm',
            videoBitsPerSecond: 5000000,
        });
        mediaRecorder.ondataavailable = (event) => recordedChunks.push(event.data);
        mediaRecorder.onstop = handleRecordingStop;

        // Ending the share from Chrome's own "stop sharing" bar finishes the recording too
        captureStream.getVideoTracks()[0].addEventListener('ended', () => stopScreenRecording(), { once: true });

        mediaRecorder.start();
    } catch (error) {
        captureStream?.getTracks().forEach((track) => track.stop());
        micStream?.getTracks().forEach((track) => track.stop());
        releaseRecordingResources();
        mediaRecorder = null;
        throw error;
    }

    await requestRuntime({
        type: 'desktop-recording-started',
        target: 'service-worker',
    }).catch((error) => console.warn('Failed to report recording start:', error));

    title.textContent = 'Recording your screen';
    chooseBtn.textContent = 'Stop recording';
    chooseBtn.hidden = false;
    chooseBtn.disabled = false;
    cancelBtn.hidden = true;
    setStatus('Recording… keep this window open, then click stop when you are done.');

    // Shrink the big picker backdrop into a small floating stop panel.
    try {
        const win = await chrome.windows.getCurrent();
        await chrome.windows.update(win.id, {
            state: 'normal',
            width: 400,
            height: 260,
            left: Math.max(0, (screen.availWidth || 1280) - 424),
            top: 24,
        });
    } catch (error) {
        console.warn('Could not shrink recording window:', error);
    }
};

// The popup and service worker stop screen recordings by messaging this window
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'desktop-capture' || message.type !== 'stop-recording') {
        return false;
    }

    if (stopScreenRecording()) {
        sendResponse({ success: true });
    } else {
        sendResponse({ success: false, error: 'No recording is in progress' });
    }
    return false;
});

// If the window is closed mid-recording the data is lost, but at least make
// sure the toolbar badge doesn't stay stuck in the recording state.
window.addEventListener('pagehide', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        chrome.runtime.sendMessage({
            type: 'desktop-recording-stopped',
            target: 'service-worker',
        }).catch(() => {});
    }
});

// Opens Chrome's picker right away; this window is just the backdrop it needs.
const beginCapture = async () => {
    chooseBtn.hidden = true;
    setStatus('Choose an entire screen or an app window in the dialog…');

    try {
        const streamId = await chooseDesktopMedia();
        if (!streamId) {
            window.close();
            return;
        }

        if (isRecording) {
            setStatus('Starting screen recording…');
            await startScreenRecording(streamId);
            return;
        }

        setStatus('Capturing screenshot…');
        await takeDesktopScreenshot(streamId);
        setStatus('Screenshot captured.', 'success');
        setTimeout(() => window.close(), 250);
    } catch (error) {
        console.error('Desktop capture failed:', error);
        chooseBtn.hidden = false;
        chooseBtn.disabled = false;
        chooseBtn.textContent = 'Try again';
        setStatus(`${isRecording ? 'Recording' : 'Capture'} failed: ${error.message}.`, 'error');
    }
};

chooseBtn.addEventListener('click', () => {
    if (mediaRecorder) {
        stopScreenRecording();
        return;
    }
    beginCapture();
});

cancelBtn.addEventListener('click', () => window.close());

title.textContent = isRecording ? 'Record a screen or window' : 'Capture a screen or window';
beginCapture();
