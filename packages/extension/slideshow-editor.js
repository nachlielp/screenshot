import { getCapture, saveCapture } from './utils/db.js';
import { uploadSlideshowToConvex } from './utils/convex-client.js';
import { isAuthenticated } from './utils/auth.js';
import {
  getResolvedSlideshowSession,
  updateSlideshowFrame,
  deleteSlideshowFrame,
  setSlideshowSessionState,
  clearSlideshowSession,
} from './utils/slideshow.js';

let canvas;
let ctx;
let tempCanvas;
let tempCtx;
let currentTool = null;
let currentColor = '#ef4444';
let currentThickness = 7;
let currentFontSize = 20;
let isDrawing = false;
let startX = 0;
let startY = 0;
let textInputActive = false;
let history = [];
let historyIndex = -1;
let currentSessionId = null;
let currentSession = null;
let currentFrameIndex = 0;
let currentCaptureId = null;
let activeConfirmCleanup = null;

const MAX_HISTORY = 50;

function getSessionIdFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return params.get('id');
}

function updateHistoryButtons() {
  document.getElementById('undo-btn').disabled = historyIndex <= 0;
  document.getElementById('redo-btn').disabled = historyIndex >= history.length - 1;
}

function saveHistory() {
  if (!ctx || !canvas) return;

  if (historyIndex < history.length - 1) {
    history = history.slice(0, historyIndex + 1);
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  history.push({
    imageData,
    width: canvas.width,
    height: canvas.height,
  });

  if (history.length > MAX_HISTORY) {
    history.shift();
  } else {
    historyIndex += 1;
  }

  updateHistoryButtons();
}

function resetHistory() {
  history = [];
  historyIndex = -1;
  updateHistoryButtons();
}

function restoreFromHistory() {
  const state = history[historyIndex];
  if (!state || !ctx || !canvas) return;
  canvas.width = state.width;
  canvas.height = state.height;
  ctx.putImageData(state.imageData, 0, 0);
}

function undo() {
  if (historyIndex > 0) {
    historyIndex -= 1;
    restoreFromHistory();
    updateHistoryButtons();
  }
}

function redo() {
  if (historyIndex < history.length - 1) {
    historyIndex += 1;
    restoreFromHistory();
    updateHistoryButtons();
  }
}

function selectTool(tool) {
  document.querySelectorAll('.tool-btn').forEach((button) => {
    if (button.id === 'undo-btn' || button.id === 'redo-btn' || button.id === 'copy-btn' || button.id === 'done-btn') {
      return;
    }
    if (button.id === 'prev-frame-btn' || button.id === 'next-frame-btn' || button.id === 'toggle-hide-btn' || button.id === 'delete-frame-btn') {
      return;
    }
    button.classList.remove('active');
  });

  if (currentTool === tool) {
    currentTool = null;
    canvas.style.cursor = 'default';
    return;
  }

  currentTool = tool;
  if (!tool) {
    canvas.style.cursor = 'default';
    return;
  }

  document.getElementById(`${tool}-btn`).classList.add('active');
  canvas.style.cursor = 'crosshair';
}

function selectColor(button) {
  currentColor = button.dataset.color;
  document.querySelectorAll('.color-btn').forEach((entry) => entry.classList.remove('active'));
  button.classList.add('active');
}

function getCanvasCoordinates(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

function drawRectangle(x1, y1, x2, y2) {
  const width = x2 - x1;
  const height = y2 - y1;
  ctx.strokeRect(x1, y1, width, height);
}

function drawArrow(x1, y1, x2, y2) {
  const headLength = 20;
  const angle = Math.atan2(y2 - y1, x2 - x1);

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLength * Math.cos(angle - Math.PI / 6),
    y2 - headLength * Math.sin(angle - Math.PI / 6)
  );
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLength * Math.cos(angle + Math.PI / 6),
    y2 - headLength * Math.sin(angle + Math.PI / 6)
  );
  ctx.stroke();
}

function drawCropPreview(x1, y1, x2, y2) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const width = x2 - x1;
  const height = y2 - y1;
  ctx.clearRect(x1, y1, width, height);
  ctx.drawImage(tempCanvas, x1, y1, width, height, x1, y1, width, height);

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.strokeRect(x1, y1, width, height);
  ctx.setLineDash([]);
}

function executeCrop(x1, y1, x2, y2) {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  if (width < 10 || height < 10) {
    ctx.drawImage(tempCanvas, 0, 0);
    return;
  }

  const croppedData = ctx.getImageData(left, top, width, height);
  canvas.width = width;
  canvas.height = height;
  ctx.putImageData(croppedData, 0, 0);

  saveHistory();
  selectTool(null);
}

function placeTextInput(clientX, clientY) {
  const overlay = document.getElementById('text-input-overlay');
  const input = document.getElementById('text-input');

  overlay.style.left = `${clientX}px`;
  overlay.style.top = `${clientY}px`;
  overlay.style.display = 'block';

  input.value = '';
  input.focus();
  textInputActive = true;
  isDrawing = false;

  overlay.onclick = (event) => {
    event.stopPropagation();
  };

  input.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finalizeText(clientX, clientY, input.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelText();
    }
  };

  setTimeout(() => {
    input.onblur = () => {
      setTimeout(() => {
        if (textInputActive) {
          finalizeText(clientX, clientY, input.value);
        }
      }, 150);
    };
  }, 100);
}

function finalizeText(clientX, clientY, text) {
  if (!text.trim()) {
    cancelText();
    return;
  }

  const coords = getCanvasCoordinates({ clientX, clientY });
  ctx.font = `${currentFontSize}px Arial`;
  ctx.fillStyle = currentColor;
  ctx.textBaseline = 'top';
  ctx.fillText(text, coords.x, coords.y);

  saveHistory();
  cancelText();
}

function cancelText() {
  document.getElementById('text-input-overlay').style.display = 'none';
  textInputActive = false;
}

function handleMouseDown(event) {
  if (!currentTool || textInputActive) return;

  const coords = getCanvasCoordinates(event);
  startX = coords.x;
  startY = coords.y;
  isDrawing = true;

  if (currentTool === 'text') {
    placeTextInput(event.clientX, event.clientY);
    return;
  }

  tempCanvas.width = canvas.width;
  tempCanvas.height = canvas.height;
  tempCtx.drawImage(canvas, 0, 0);
}

function handleMouseMove(event) {
  if (!isDrawing || !currentTool || currentTool === 'text') return;

  const coords = getCanvasCoordinates(event);
  ctx.drawImage(tempCanvas, 0, 0);

  ctx.strokeStyle = currentColor;
  ctx.lineWidth = currentThickness;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (currentTool === 'crop') {
    drawCropPreview(startX, startY, coords.x, coords.y);
  } else if (currentTool === 'rectangle') {
    drawRectangle(startX, startY, coords.x, coords.y);
  } else if (currentTool === 'arrow') {
    drawArrow(startX, startY, coords.x, coords.y);
  }
}

function handleMouseUp(event) {
  if (!isDrawing) return;
  isDrawing = false;

  if (!currentTool || currentTool === 'text') return;

  const coords = getCanvasCoordinates(event);

  if (currentTool === 'crop') {
    executeCrop(startX, startY, coords.x, coords.y);
  } else {
    saveHistory();
  }
}

async function copyToClipboard() {
  try {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);

    const button = document.getElementById('copy-btn');
    const originalMarkup = button.innerHTML;
    button.innerHTML = '<span>✓</span><span>Copied!</span>';
    setTimeout(() => {
      button.innerHTML = originalMarkup;
    }, 2000);
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
    alert('Failed to copy to clipboard');
  }
}

function setFrameStatus(frame) {
  const total = currentSession?.frames?.length ?? 0;
  const hiddenSuffix = frame?.hidden ? ' • Hidden' : '';
  document.getElementById('frame-status').textContent = `Frame ${currentFrameIndex + 1} of ${total}${hiddenSuffix}`;
  document.getElementById('toggle-hide-btn').textContent = frame?.hidden ? 'Unhide Slide' : 'Hide Slide';
  document.getElementById('prev-frame-btn').disabled = currentFrameIndex <= 0;
  document.getElementById('next-frame-btn').disabled = currentFrameIndex >= total - 1;
}

function updateThumbnailStrip() {
  const strip = document.getElementById('thumbnail-strip');
  strip.innerHTML = '';

  currentSession.frames.forEach((frame, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `thumbnail-btn${index === currentFrameIndex ? ' active' : ''}${frame.hidden ? ' hidden-frame' : ''}`;

    const image = document.createElement('img');
    image.src = URL.createObjectURL(frame.capture.blob);
    image.alt = frame.capture.filename || `Frame ${index + 1}`;
    button.appendChild(image);

    button.addEventListener('click', async () => {
      await navigateToFrame(index);
    });

    strip.appendChild(button);
  });
}

async function loadImageToCanvas(blob) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);

    image.onload = () => {
      canvas.width = image.width;
      canvas.height = image.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0);
      URL.revokeObjectURL(objectUrl);
      resolve();
    };

    image.onerror = reject;
    image.src = objectUrl;
  });
}

async function refreshSession() {
  currentSession = await getResolvedSlideshowSession(currentSessionId);
  if (!currentSession || currentSession.frames.length === 0) {
    alert('Slideshow session not found');
    window.close();
    return false;
  }

  if (currentFrameIndex >= currentSession.frames.length) {
    currentFrameIndex = currentSession.frames.length - 1;
  }

  return true;
}

async function loadFrame(index) {
  currentFrameIndex = index;
  const frame = currentSession.frames[currentFrameIndex];
  currentCaptureId = frame.captureId;

  await loadImageToCanvas(frame.capture.blob);
  resetHistory();
  saveHistory();
  setFrameStatus(frame);
  updateThumbnailStrip();
}

async function persistCurrentFrameEdits() {
  if (!currentCaptureId || !canvas) return;

  const existingCapture = await getCapture(currentCaptureId);
  if (!existingCapture) return;

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((value) => {
      if (!value) {
        reject(new Error('Failed to persist slideshow frame'));
        return;
      }
      resolve(value);
    }, 'image/png');
  });

  await saveCapture(
    currentCaptureId,
    blob,
    existingCapture.filename,
    'image/png',
    existingCapture.consoleLogs,
    existingCapture.networkLogs,
    existingCapture.sourceUrl,
    existingCapture.deviceMeta
  );

  await updateSlideshowFrame(currentSessionId, currentCaptureId, (frame) => ({
    ...frame,
    filename: existingCapture.filename,
    mimeType: 'image/png',
    width: canvas.width,
    height: canvas.height,
  }));
}

async function navigateToFrame(index) {
  if (index === currentFrameIndex) return;
  await persistCurrentFrameEdits();
  const available = await refreshSession();
  if (!available) return;
  await loadFrame(index);
}

async function toggleFrameHidden() {
  const frame = currentSession.frames[currentFrameIndex];
  await updateSlideshowFrame(currentSessionId, frame.captureId, (entry) => ({
    ...entry,
    hidden: !entry.hidden,
  }));
  await refreshSession();
  await loadFrame(currentFrameIndex);
}

async function deleteCurrentFrame() {
  const frame = currentSession.frames[currentFrameIndex];
  const shouldDelete = await showConfirmDialog({
    title: 'Delete slide?',
    message: 'This slide will be removed from the slideshow draft.',
    confirmLabel: 'Delete slide',
    cancelLabel: 'Keep frame',
  });

  if (!shouldDelete) {
    return;
  }

  const nextSession = await deleteSlideshowFrame(currentSessionId, frame.captureId);
  if (!nextSession) {
    alert('Slideshow draft is now empty.');
    window.close();
    return;
  }

  await refreshSession();
  await loadFrame(Math.min(currentFrameIndex, currentSession.frames.length - 1));
}

async function finishEditing() {
  const doneButton = document.getElementById('done-btn');
  const originalText = doneButton.textContent;

  try {
    await persistCurrentFrameEdits();
    await setSlideshowSessionState(currentSessionId, 'editing');

    const authenticated = await isAuthenticated();
    if (!authenticated) {
      alert('Please sign in from the extension popup before uploading this slideshow.');
      return;
    }

    doneButton.disabled = true;
    doneButton.textContent = 'Uploading...';

    const session = await getResolvedSlideshowSession(currentSessionId);
    const result = await uploadSlideshowToConvex(session);

    try {
      await navigator.clipboard.writeText(result.shareUrl);
    } catch (error) {
      console.warn('Could not copy slideshow link to clipboard:', error);
    }

    await clearSlideshowSession(currentSessionId);
    window.location.href = result.shareUrl;
  } catch (error) {
    console.error('Failed to upload slideshow:', error);
    alert(error.message || 'Failed to upload slideshow');
  } finally {
    doneButton.disabled = false;
    doneButton.textContent = originalText;
  }
}

function showConfirmDialog({
  title,
  message,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
}) {
  const overlay = document.getElementById('confirm-overlay');
  const titleEl = document.getElementById('confirm-title');
  const messageEl = document.getElementById('confirm-message');
  const confirmBtn = document.getElementById('confirm-ok-btn');
  const cancelBtn = document.getElementById('confirm-cancel-btn');

  if (!overlay || !titleEl || !messageEl || !confirmBtn || !cancelBtn) {
    return Promise.resolve(false);
  }

  if (activeConfirmCleanup) {
    activeConfirmCleanup(false);
  }

  titleEl.textContent = title;
  messageEl.textContent = message;
  confirmBtn.textContent = confirmLabel;
  cancelBtn.textContent = cancelLabel;
  overlay.classList.add('open');

  return new Promise((resolve) => {
    const close = (result) => {
      overlay.classList.remove('open');
      document.removeEventListener('keydown', handleKeyDown);
      overlay.removeEventListener('click', handleOverlayClick);
      confirmBtn.removeEventListener('click', handleConfirm);
      cancelBtn.removeEventListener('click', handleCancel);
      activeConfirmCleanup = null;
      resolve(result);
    };

    const handleConfirm = () => close(true);
    const handleCancel = () => close(false);
    const handleOverlayClick = (event) => {
      if (event.target === overlay) {
        close(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        close(false);
      }
    };

    activeConfirmCleanup = close;
    document.addEventListener('keydown', handleKeyDown);
    overlay.addEventListener('click', handleOverlayClick);
    confirmBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', handleCancel);
    confirmBtn.focus();
  });
}

async function init() {
  currentSessionId = getSessionIdFromLocation();
  if (!currentSessionId) {
    alert('No slideshow ID provided');
    return;
  }

  canvas = document.getElementById('editor-canvas');
  ctx = canvas.getContext('2d', { willReadFrequently: true });
  tempCanvas = document.createElement('canvas');
  tempCtx = tempCanvas.getContext('2d');

  const available = await refreshSession();
  if (!available) return;

  await loadFrame(0);
  document.getElementById('loading').style.display = 'none';
  document.getElementById('toolbar-header').style.display = 'flex';
}

document.getElementById('undo-btn').addEventListener('click', undo);
document.getElementById('redo-btn').addEventListener('click', redo);
document.getElementById('crop-btn').addEventListener('click', () => selectTool('crop'));
document.getElementById('rectangle-btn').addEventListener('click', () => selectTool('rectangle'));
document.getElementById('arrow-btn').addEventListener('click', () => selectTool('arrow'));
document.getElementById('text-btn').addEventListener('click', () => selectTool('text'));
document.getElementById('copy-btn').addEventListener('click', copyToClipboard);
document.getElementById('done-btn').addEventListener('click', finishEditing);
document.getElementById('prev-frame-btn').addEventListener('click', () => navigateToFrame(currentFrameIndex - 1));
document.getElementById('next-frame-btn').addEventListener('click', () => navigateToFrame(currentFrameIndex + 1));
document.getElementById('toggle-hide-btn').addEventListener('click', toggleFrameHidden);
document.getElementById('delete-frame-btn').addEventListener('click', deleteCurrentFrame);

document.querySelectorAll('.color-btn').forEach((button) => {
  button.addEventListener('click', () => selectColor(button));
});

document.getElementById('thickness-slider').addEventListener('input', (event) => {
  currentThickness = parseInt(event.target.value, 10);
  document.getElementById('thickness-value').textContent = `${currentThickness}px`;
});

document.getElementById('font-size-slider').addEventListener('input', (event) => {
  currentFontSize = parseInt(event.target.value, 10);
  document.getElementById('font-size-value').textContent = `${currentFontSize}px`;
});

document.addEventListener('DOMContentLoaded', async () => {
  await init();
  canvas.addEventListener('mousedown', handleMouseDown);
  canvas.addEventListener('mousemove', handleMouseMove);
  canvas.addEventListener('mouseup', handleMouseUp);
});
