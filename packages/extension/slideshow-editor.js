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
import {
  AnnotationEngine,
  parseAnnotations,
  renderAnnotatedBlob,
} from './shared/annotation-engine.js';

let engine = null;
let activeTextRequest = null;
let currentSessionId = null;
let currentSession = null;
let currentFrameIndex = 0;
let currentCaptureId = null;
let activeConfirmCleanup = null;

const TOOL_BUTTONS = {
  select: 'select-btn',
  crop: 'crop-btn',
  rect: 'rectangle-btn',
  arrow: 'arrow-btn',
  line: 'line-btn',
  freehand: 'freehand-btn',
  text: 'text-btn',
};

function getSessionIdFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return params.get('id');
}

function updateHistoryButtons({ canUndo, canRedo } = {}) {
  document.getElementById('undo-btn').disabled = !canUndo;
  document.getElementById('redo-btn').disabled = !canRedo;
}

function handleSelectionChange(annotation) {
  document.getElementById('delete-btn').disabled = !annotation;

  if (annotation) {
    engine.color = annotation.color;
    engine.thickness = annotation.thickness;
    if (annotation.fontSize) engine.fontSize = annotation.fontSize;

    document.querySelectorAll('.color-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.color === annotation.color);
    });
    const thicknessSlider = document.getElementById('thickness-slider');
    if (thicknessSlider) {
      thicknessSlider.value = String(annotation.thickness);
      document.getElementById('thickness-value').textContent = `${annotation.thickness}px`;
    }
    const fontSizeSlider = document.getElementById('font-size-slider');
    if (fontSizeSlider && annotation.fontSize) {
      fontSizeSlider.value = String(annotation.fontSize);
      document.getElementById('font-size-value').textContent = `${annotation.fontSize}px`;
    }
    const nativePicker = document.getElementById('color-picker-native');
    if (nativePicker) nativePicker.value = annotation.color;
  }
}

function selectTool(tool) {
  engine.setTool(tool);
  Object.entries(TOOL_BUTTONS).forEach(([key, id]) => {
    document.getElementById(id)?.classList.toggle('active', key === tool);
  });
}

// ── Text input overlay ────────────────────────────────────────────────

function handleTextEditRequest(request) {
  const overlay = document.getElementById('text-input-overlay');
  const input = document.getElementById('text-input');

  // If a text box is already open, this request came from a click meant to
  // dismiss it (the text tool is still active). Commit what's been typed and
  // return to the select tool instead of opening a second box — this mirrors
  // finishing a shape, and keeps the just-placed text from being discarded.
  if (isTextInputActive()) {
    finalizeText(input.value);
    return;
  }

  activeTextRequest = { ...request, finalized: false };

  overlay.style.display = 'block';

  // Match the input to the drawn text: same colour, and the same on-screen size
  // (the canvas is displayed scaled down, so the raw font size in image pixels
  // must be multiplied by the display scale to look identical).
  const fontSize = request.annotation?.fontSize ?? engine.fontSize;
  input.style.fontSize = `${fontSize * engine.displayScale}px`;
  input.style.color = request.annotation?.color ?? engine.color;

  // The engine anchors committed text with its top-left at the click point, but
  // the characters typed in the input sit inset by the input's border + padding.
  // Pull the overlay up-left by that inset so the typed text lies exactly on the
  // anchor and doesn't jump when committed.
  const inputStyle = getComputedStyle(input);
  const insetX =
    parseFloat(inputStyle.borderLeftWidth) + parseFloat(inputStyle.paddingLeft);
  const insetY =
    parseFloat(inputStyle.borderTopWidth) + parseFloat(inputStyle.paddingTop);
  overlay.style.left = `${request.clientX - insetX}px`;
  overlay.style.top = `${request.clientY - insetY}px`;

  input.value = request.annotation?.text || '';
  input.focus();

  overlay.onclick = (event) => event.stopPropagation();

  input.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finalizeText(input.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelText();
    }
  };

  input.onblur = () => finalizeText(input.value);
}

function finalizeText(text) {
  const request = activeTextRequest;
  if (!request || request.finalized) return;
  request.finalized = true;

  let committed = false;
  if (request.annotation) {
    engine.updateText(request.annotation.id, text);
    committed = true;
  } else if (text.trim()) {
    // Nudge the anchor down one screen pixel: canvas text (textBaseline 'top')
    // renders a hair higher than the same text in the input's line box.
    engine.insertText(
      {
        x: request.imagePoint.x,
        y: request.imagePoint.y + 1 / engine.displayScale,
      },
      text
    );
    committed = true;
  }

  closeTextOverlay();

  // Land on the select tool with the new text selected, so it can be grabbed
  // and moved right away — the same flow as after drawing a shape.
  if (committed) selectTool('select');
}

function cancelText() {
  if (activeTextRequest) activeTextRequest.finalized = true;
  closeTextOverlay();
}

function closeTextOverlay() {
  document.getElementById('text-input-overlay').style.display = 'none';
  activeTextRequest = null;
}

function isTextInputActive() {
  return Boolean(activeTextRequest && !activeTextRequest.finalized);
}

async function copyToClipboard() {
  try {
    const blob = await engine.exportBlob('image/png');
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

// ── Frames ────────────────────────────────────────────────────────────

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

  await engine.loadImage(frame.capture.blob, {
    annotations: parseAnnotations(frame.annotations),
  });
  selectTool('select');
  setFrameStatus(frame);
  updateThumbnailStrip();
}

// Persist the current frame: the capture blob stays the unannotated base
// (crop gets baked in when used), the vector annotations live on the frame.
async function persistCurrentFrameEdits() {
  if (!currentCaptureId || !engine) return;

  if (isTextInputActive()) {
    finalizeText(document.getElementById('text-input').value);
  }

  const annotations = engine.getAnnotations({ relativeToCrop: true });
  const annotationsJson = annotations.length > 0
    ? engine.serialize({ relativeToCrop: true })
    : null;

  if (engine.hasCrop) {
    const existingCapture = await getCapture(currentCaptureId);
    if (!existingCapture) return;

    const baseBlob = await engine.exportBaseBlob('image/png');
    await saveCapture(
      currentCaptureId,
      baseBlob,
      existingCapture.filename,
      'image/png',
      existingCapture.consoleLogs,
      existingCapture.networkLogs,
      existingCapture.sourceUrl,
      existingCapture.deviceMeta
    );
  }

  await updateSlideshowFrame(currentSessionId, currentCaptureId, (frame) => ({
    ...frame,
    mimeType: 'image/png',
    width: engine.canvas.width,
    height: engine.canvas.height,
    annotations: annotationsJson,
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
  await persistCurrentFrameEdits();
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

// Flatten each frame's annotations into its blob for upload — the shared
// slideshow shows exactly what was drawn.
async function buildUploadSession(session) {
  const frames = [];
  for (const frame of session.frames) {
    let blob = frame.capture?.blob;
    if (blob && frame.annotations) {
      try {
        blob = await renderAnnotatedBlob(blob, frame.annotations);
      } catch (error) {
        console.warn('Failed to flatten frame annotations, uploading base image:', error);
      }
    }
    frames.push({
      ...frame,
      capture: { ...frame.capture, blob },
    });
  }
  return { ...session, frames };
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
    const uploadSession = await buildUploadSession(session);
    const result = await uploadSlideshowToConvex(uploadSession);

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

  const canvas = document.getElementById('editor-canvas');
  engine = new AnnotationEngine(canvas, {
    enableCrop: true,
    onSelectionChange: handleSelectionChange,
    onHistoryChange: updateHistoryButtons,
    onTextEditRequest: handleTextEditRequest,
  });
  engine.thickness = parseInt(document.getElementById('thickness-slider')?.value ?? '7', 10);
  engine.fontSize = parseInt(document.getElementById('font-size-slider')?.value ?? '84', 10);

  const available = await refreshSession();
  if (!available) return;

  await loadFrame(0);
  document.getElementById('loading').style.display = 'none';
  document.getElementById('toolbar-header').style.display = 'flex';
}

document.getElementById('undo-btn').addEventListener('click', () => engine.undo());
document.getElementById('redo-btn').addEventListener('click', () => engine.redo());
document.getElementById('select-btn').addEventListener('click', () => selectTool('select'));
document.getElementById('crop-btn').addEventListener('click', () => selectTool('crop'));
document.getElementById('rectangle-btn').addEventListener('click', () => selectTool('rect'));
document.getElementById('arrow-btn').addEventListener('click', () => selectTool('arrow'));
document.getElementById('line-btn').addEventListener('click', () => selectTool('line'));
document.getElementById('freehand-btn').addEventListener('click', () => selectTool('freehand'));
document.getElementById('text-btn').addEventListener('click', () => selectTool('text'));
document.getElementById('delete-btn').addEventListener('click', () => engine.deleteSelected());
document.getElementById('copy-btn').addEventListener('click', copyToClipboard);
document.getElementById('done-btn').addEventListener('click', finishEditing);
document.getElementById('prev-frame-btn').addEventListener('click', () => navigateToFrame(currentFrameIndex - 1));
document.getElementById('next-frame-btn').addEventListener('click', () => navigateToFrame(currentFrameIndex + 1));
document.getElementById('toggle-hide-btn').addEventListener('click', toggleFrameHidden);
document.getElementById('delete-frame-btn').addEventListener('click', deleteCurrentFrame);

const nativeColorPicker = document.getElementById('color-picker-native');
document.querySelectorAll('.color-btn').forEach((button) => {
  button.addEventListener('click', () => {
    engine.setColor(button.dataset.color);
    document.querySelectorAll('.color-btn').forEach((entry) => entry.classList.remove('active'));
    button.classList.add('active');
    if (nativeColorPicker) nativeColorPicker.value = button.dataset.color;
  });
});

// Custom colour. Picking a colour clears the preset highlight unless it matches.
if (nativeColorPicker) {
  nativeColorPicker.addEventListener('input', (event) => {
    const color = event.target.value;
    engine.setColor(color);
    document.querySelectorAll('.color-btn').forEach((entry) => {
      entry.classList.toggle('active', entry.dataset.color === color);
    });
  });
}

document.getElementById('thickness-slider').addEventListener('input', (event) => {
  const thickness = parseInt(event.target.value, 10);
  engine.setThickness(thickness);
  document.getElementById('thickness-value').textContent = `${thickness}px`;
});

document.getElementById('font-size-slider').addEventListener('input', (event) => {
  const fontSize = parseInt(event.target.value, 10);
  engine.setFontSize(fontSize);
  document.getElementById('font-size-value').textContent = `${fontSize}px`;
});

document.addEventListener('DOMContentLoaded', async () => {
  await init();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (!engine || isTextInputActive()) return;
  const target = e.target;
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    if (e.shiftKey) {
      engine.redo();
    } else {
      engine.undo();
    }
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
    e.preventDefault();
    copyToClipboard();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (engine.deleteSelected()) e.preventDefault();
  } else if (e.key === 'Escape') {
    selectTool('select');
  } else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
    const toolByKey = { v: 'select', r: 'rect', a: 'arrow', l: 'line', p: 'freehand', t: 'text' };
    const tool = toolByKey[e.key.toLowerCase()];
    if (tool) selectTool(tool);
  }
});
