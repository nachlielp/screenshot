import { getCapture, saveCapture, deleteCapture } from './utils/db.js';
import { uploadToConvex } from './utils/convex-client.js';
import { isAuthenticated } from './utils/auth.js';
import { getRuntimeConfig } from './utils/runtime-config.js';
import {
  createSlideshowSession,
  appendFrameToSlideshowSession,
  setSlideshowSessionState,
  getSlideshowSession,
} from './utils/slideshow.js';

const VERSION = 'v2.0.0';
console.log(`[Video] Module loaded - ${VERSION}`);

const previewContainer = document.getElementById('preview');
const downloadBtn = document.getElementById('downloadBtn');
const downloadConsoleBtn = document.getElementById('downloadConsoleBtn');
const downloadNetworkBtn = document.getElementById('downloadNetworkBtn');
const shareBtn = document.getElementById('shareBtn');
const shareText = document.getElementById('shareText');
const linkDisplay = document.getElementById('linkDisplay');
const errorDiv = document.getElementById('error');
const reviewBar = document.getElementById('reviewBar');
const filmstrip = document.getElementById('filmstrip');
const snapFrameBtn = document.getElementById('snapFrameBtn');
const annotateFramesBtn = document.getElementById('annotateFramesBtn');
const annotateFramesText = document.getElementById('annotateFramesText');

let currentCapture = null;
let blobUrl = null;
let videoEl = null;
let frameSessionId = null;
let snappedCount = 0;

async function init() {
  try {
    // Get capture ID and type from URL params
    const params = new URLSearchParams(window.location.search);
    const captureId = params.get('id');
    const captureType = params.get('type');
    
    if (!captureId) {
      showError('No capture ID provided');
      return;
    }
    
    // Load capture from IndexedDB
    currentCapture = await getCapture(captureId);
    
    if (!currentCapture) {
      showError('Capture not found or expired');
      return;
    }
    
    // Create blob URL for display
    blobUrl = URL.createObjectURL(currentCapture.blob);
    
    // Display preview based on type
    if (captureType === 'video' || currentCapture.mimeType.startsWith('video/')) {
      videoEl = document.createElement('video');
      videoEl.src = blobUrl;
      videoEl.controls = true;
      videoEl.autoplay = true;
      videoEl.loop = true;
      previewContainer.appendChild(videoEl);
      void setupVideoReview();
    } else {
      const img = document.createElement('img');
      img.src = blobUrl;
      img.alt = 'Screenshot preview';
      previewContainer.appendChild(img);
    }
    
    // Set up event listeners
    downloadBtn.addEventListener('click', handleDownload);
    shareBtn.addEventListener('click', handleShare);
    
    // Show console logs download button if consoleLogs exist
    if (currentCapture.consoleLogs && currentCapture.consoleLogs.length > 0) {
      downloadConsoleBtn.style.display = 'flex';
      downloadConsoleBtn.addEventListener('click', handleDownloadConsole);
    }

    // Show network logs download button if networkLogs exist
    if (currentCapture.networkLogs && currentCapture.networkLogs.length > 0) {
      downloadNetworkBtn.style.display = 'flex';
      downloadNetworkBtn.addEventListener('click', handleDownloadNetwork);
    }
    
    // Clean up blob URL and IndexedDB when window closes
    window.addEventListener('beforeunload', cleanup);
    
  } catch (error) {
    console.error('Failed to load capture:', error);
    showError('Failed to load capture: ' + error.message);
  }
}

// ── Video review: filmstrip + frame snapping ─────────────────────────

/**
 * MediaRecorder WebM blobs report Infinity duration until the browser is
 * forced to scan the file — seek far past the end and wait for the fixup.
 */
function resolveVideoDuration(video) {
  return new Promise((resolve) => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      resolve(video.duration);
      return;
    }

    const timeout = setTimeout(() => resolve(null), 4000);
    const onDurationChange = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        clearTimeout(timeout);
        video.removeEventListener('durationchange', onDurationChange);
        video.currentTime = 0;
        resolve(video.duration);
      }
    };
    video.addEventListener('durationchange', onDurationChange);
    video.currentTime = Number.MAX_SAFE_INTEGER;
  });
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function grabFrameAt(video, time) {
  await new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
  });

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas;
}

async function setupVideoReview() {
  try {
    await new Promise((resolve) => {
      if (videoEl.readyState >= 1) resolve();
      else videoEl.addEventListener('loadedmetadata', resolve, { once: true });
    });

    reviewBar.classList.add('show');
    snapFrameBtn.addEventListener('click', () => void snapCurrentFrame());
    annotateFramesBtn.addEventListener('click', () => void openFrameAnnotator());

    await buildFilmstrip();
  } catch (error) {
    console.warn('Video review setup failed (snap still available):', error);
    reviewBar.classList.add('show');
  }
}

async function buildFilmstrip() {
  // Use a separate muted video element so thumbnail seeking never fights
  // with the user's playback.
  const probe = document.createElement('video');
  probe.muted = true;
  probe.preload = 'auto';
  probe.src = blobUrl;

  await new Promise((resolve, reject) => {
    probe.addEventListener('loadedmetadata', resolve, { once: true });
    probe.addEventListener('error', () => reject(new Error('Could not load video for thumbnails')), { once: true });
  });

  const duration = await resolveVideoDuration(probe);
  if (!duration) {
    console.warn('Could not determine video duration; skipping filmstrip');
    return;
  }

  const thumbCount = Math.min(12, Math.max(4, Math.round(duration)));
  for (let i = 0; i < thumbCount; i += 1) {
    const time = (duration * i) / thumbCount;
    try {
      const canvas = await grabFrameAt(probe, time);
      if (canvas.width === 0) continue;

      const button = document.createElement('button');
      button.type = 'button';
      button.title = `Jump to ${formatTime(time)}`;

      const img = document.createElement('img');
      const scale = 62 / canvas.height;
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = Math.round(canvas.width * scale);
      thumbCanvas.height = 62;
      thumbCanvas.getContext('2d').drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
      img.src = thumbCanvas.toDataURL('image/jpeg', 0.7);

      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = formatTime(time);

      button.appendChild(img);
      button.appendChild(ts);
      button.addEventListener('click', () => {
        videoEl.pause();
        videoEl.currentTime = time;
      });

      filmstrip.appendChild(button);
    } catch (error) {
      console.warn(`Thumbnail at ${time}s failed:`, error);
    }
  }
}

async function snapCurrentFrame() {
  if (!videoEl || videoEl.videoWidth === 0) return;

  try {
    snapFrameBtn.disabled = true;
    videoEl.pause();

    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    canvas.getContext('2d').drawImage(videoEl, 0, 0);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('Failed to grab frame'))), 'image/png');
    });

    const time = videoEl.currentTime;
    const captureId = crypto.randomUUID();
    const baseName = currentCapture.filename.replace(/\.(webm|mp4)$/i, '');
    const filename = `${baseName}-frame-${time.toFixed(1)}s.png`;

    await saveCapture(
      captureId,
      blob,
      filename,
      'image/png',
      null,
      null,
      currentCapture.sourceUrl || null,
      currentCapture.deviceMeta || null
    );

    if (!frameSessionId) {
      const session = await createSlideshowSession({ title: baseName });
      frameSessionId = session.id;
    } else {
      // The session may have been consumed by a finished annotator tab
      const existing = await getSlideshowSession(frameSessionId);
      if (!existing) {
        const session = await createSlideshowSession({ title: baseName });
        frameSessionId = session.id;
        snappedCount = 0;
      }
    }

    await appendFrameToSlideshowSession(frameSessionId, {
      captureId,
      source: 'tab',
      sourceUrl: currentCapture.sourceUrl || undefined,
      filename,
      mimeType: 'image/png',
      width: canvas.width,
      height: canvas.height,
      captureTimestamp: new Date().toISOString(),
    });

    snappedCount += 1;
    annotateFramesText.textContent = `Annotate frames (${snappedCount})`;
    annotateFramesBtn.disabled = false;

    const originalHtml = snapFrameBtn.innerHTML;
    snapFrameBtn.innerHTML = `<span>✓</span><span>Snapped ${formatTime(time)}</span>`;
    setTimeout(() => {
      snapFrameBtn.innerHTML = originalHtml;
    }, 1200);
  } catch (error) {
    console.error('Failed to snap frame:', error);
    showError('Failed to snap frame: ' + error.message);
  } finally {
    snapFrameBtn.disabled = false;
  }
}

async function openFrameAnnotator() {
  if (!frameSessionId) return;

  await setSlideshowSessionState(frameSessionId, 'editing');
  const editorUrl = chrome.runtime.getURL(`slideshow-editor.html?id=${frameSessionId}`);
  await chrome.tabs.create({ url: editorUrl });
}

function handleDownload() {
  if (!currentCapture || !blobUrl) return;
  
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = currentCapture.filename;
  a.click();
}

function handleDownloadConsole() {
  if (!currentCapture || !currentCapture.consoleLogs) return;
  const blob = new Blob([JSON.stringify(currentCapture.consoleLogs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const name = currentCapture.filename.replace(/\.(png|jpe?g|webm|mp4)$/i, '-console.json');
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function handleDownloadNetwork() {
  if (!currentCapture || !currentCapture.networkLogs) return;
  const blob = new Blob([JSON.stringify(currentCapture.networkLogs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const name = currentCapture.filename.replace(/\.(png|jpe?g|webm|mp4)$/i, '-network.json');
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

async function handleShare() {
  if (!currentCapture) return;
  
  try {
    // Check if user is authenticated
    const authenticated = await isAuthenticated();
    if (!authenticated) {
      showError('Please sign in to share captures');
      shareBtn.disabled = false;
      return;
    }
    
    // Disable button and show loading
    shareBtn.disabled = true;
    shareText.innerHTML = '<span class="spinner"></span><span>Uploading...</span>';
    
    // Debug logging
    console.log('currentCapture:', currentCapture);
    console.log('blob:', currentCapture.blob);
    console.log('filename:', currentCapture.filename);
    console.log('mimeType:', currentCapture.mimeType);
    console.log('blob.size:', currentCapture.blob?.size);
    
    // Determine capture type based on filename
    let captureType = 'screenshot';
    if (currentCapture.filename.includes('recording')) {
      captureType = currentCapture.filename.includes('screen') ? 'screen-recording' : 'tab-recording';
    }
    
    // Upload to Convex
    const result = await uploadToConvex(
      currentCapture.blob,
      currentCapture.filename,
      currentCapture.mimeType,
      captureType,
      { sourceUrl: currentCapture.sourceUrl || undefined },
      currentCapture.consoleLogs || null,
      currentCapture.networkLogs || null,
      currentCapture.deviceMeta || null
    );
    
    // Build the hosted snapshot URL so the preview opens in the web app.
    const config = await getRuntimeConfig();
    const previewLink = result.shareToken
      ? `${config.siteUrl}/#/snapshot/${result.shareToken}`
      : result.publicUrl;

    if (!previewLink) {
      throw new Error('Upload succeeded, but no preview URL was returned');
    }
    
    // Store the preview link
    shareBtn.dataset.previewLink = previewLink;
    
    // Display the link
    linkDisplay.textContent = previewLink;
    linkDisplay.classList.add('show');
    
    // Copy preview URL to clipboard (with small delay to ensure focus)
    setTimeout(async () => {
      try {
        await navigator.clipboard.writeText(previewLink);
        shareBtn.classList.add('copied');
        shareText.textContent = '✓ Link Copied!';
        
        // Change button to "Open Preview" after showing success
        setTimeout(() => {
          shareBtn.classList.remove('copied');
          shareBtn.innerHTML = '<span>🔍</span><span>Open Preview</span>';
          shareBtn.disabled = false;
          
          // Replace the event listener with new handler
          shareBtn.removeEventListener('click', handleShare);
          shareBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: previewLink });
          });
        }, 1500);
      } catch (clipError) {
        console.warn('Could not copy to clipboard:', clipError);
        // Still change to Open Preview even if copy fails
        shareBtn.classList.remove('copied');
        shareBtn.innerHTML = '<span>🔍</span><span>Open Preview</span>';
        shareBtn.disabled = false;
        
        // Replace the event listener with new handler
        shareBtn.removeEventListener('click', handleShare);
        shareBtn.addEventListener('click', () => {
          chrome.tabs.create({ url: previewLink });
        });
      }
    }, 100);
    
  } catch (error) {
    console.error('Upload failed:', error);
    showError('Upload failed: ' + error.message);
    shareBtn.disabled = false;
    // Only reset button text if we don't have a preview link (upload actually failed)
    if (!shareBtn.dataset.previewLink) {
      shareText.innerHTML = '<span>🔗</span><span>Create Shareable Link</span>';
    }
  }
}

function cleanup() {
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
  }
  if (currentCapture) {
    deleteCapture(currentCapture.id).catch(console.error);
  }
}

function showError(message) {
  errorDiv.textContent = message;
  errorDiv.style.display = 'block';
  downloadBtn.disabled = true;
  shareBtn.disabled = true;
}

// Initialize on load
init();
