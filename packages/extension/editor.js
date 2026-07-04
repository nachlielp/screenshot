import { getCapture, saveCapture, deleteCapture } from './utils/db.js';
import { uploadToConvex } from './utils/convex-client.js';
import { getRuntimeConfig } from './utils/runtime-config.js';
import { isAuthenticated } from './utils/auth.js';
import { AnnotationEngine, parseAnnotations } from './shared/annotation-engine.js';

// Editor state
let engine = null;
let activeTextRequest = null;
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

// Initialize editor
async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  const captureId = urlParams.get('id');

  if (!captureId) {
    alert('No screenshot ID provided');
    return;
  }

  try {
    const capture = await getCapture(captureId);
    if (!capture || !capture.blob) {
      alert('Screenshot not found');
      return;
    }

    const canvas = document.getElementById('editor-canvas');
    engine = new AnnotationEngine(canvas, {
      enableCrop: true,
      onSelectionChange: handleSelectionChange,
      onHistoryChange: updateHistoryButtons,
      onToolChange: updateToolButtons,
      onTextEditRequest: handleTextEditRequest,
    });
    engine.thickness = getSliderValue('thickness-slider', 7);
    engine.fontSize = getSliderValue('font-size-slider', 20);

    await engine.loadImage(capture.blob, {
      annotations: parseAnnotations(capture.annotations),
    });
    engine.setTool('select');

    document.getElementById('loading').style.display = 'none';
    document.getElementById('toolbar-header').style.display = 'flex';
  } catch (error) {
    console.error('Failed to load screenshot:', error);
    alert('Failed to load screenshot');
  }
}

function getSliderValue(id, fallback) {
  const slider = document.getElementById(id);
  return slider ? parseInt(slider.value, 10) : fallback;
}

function updateHistoryButtons({ canUndo, canRedo } = {}) {
  document.getElementById('undo-btn').disabled = !canUndo;
  document.getElementById('redo-btn').disabled = !canRedo;
}

function handleSelectionChange(annotation) {
  document.getElementById('delete-btn').disabled = !annotation;

  if (annotation) {
    // Mirror the selection's style in the toolbar without touching history
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
  }
}

// Highlights the active tool button. Driven by the engine's onToolChange, so
// it stays in sync even when the engine auto-returns to select after drawing.
function updateToolButtons(tool) {
  Object.entries(TOOL_BUTTONS).forEach(([key, id]) => {
    document.getElementById(id)?.classList.toggle('active', key === tool);
  });
}

// Tool selection
function selectTool(tool) {
  engine.setTool(tool);
}

// ── Text input overlay ────────────────────────────────────────────────

function handleTextEditRequest(request) {
  const overlay = document.getElementById('text-input-overlay');
  const input = document.getElementById('text-input');

  activeTextRequest = { ...request, finalized: false };

  overlay.style.left = `${request.clientX}px`;
  overlay.style.top = `${request.clientY}px`;
  overlay.style.display = 'block';

  input.value = request.annotation?.text || '';
  // Defer focus to the next tick. The click that opened this overlay is still
  // settling — focusing synchronously means the browser then moves focus to
  // <body> as the click completes, which fires the input's blur and closes the
  // box instantly. Focusing after the click resolves keeps it open.
  setTimeout(() => input.focus(), 0);

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

  if (request.annotation) {
    engine.updateText(request.annotation.id, text);
  } else if (text.trim()) {
    engine.insertText(request.imagePoint, text);
  }

  closeTextOverlay();
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

// ── Upload / share flow ───────────────────────────────────────────────

function isInspectableUrl(url) {
  return typeof url === 'string' &&
    (url.startsWith('http://') || url.startsWith('https://')) &&
    !url.startsWith('chrome://') &&
    !url.startsWith('chrome-extension://');
}

async function findSourceTab(sourceUrl) {
  if (isInspectableUrl(sourceUrl)) {
    const tabs = await chrome.tabs.query({});
    const matchingTab = tabs.find((tab) => tab.url === sourceUrl && isInspectableUrl(tab.url));
    if (matchingTab) {
      return matchingTab;
    }
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && isInspectableUrl(activeTab.url)) {
    return activeTab;
  }

  return null;
}

async function collectLogsAndNetwork(sourceUrl) {
  const sourceTab = await findSourceTab(sourceUrl);
  if (!sourceTab?.id) {
    return null;
  }

  await chrome.scripting.executeScript({
    target: { tabId: sourceTab.id },
    files: ['content.js'],
  }).catch(() => {});

  const logsResponse = await chrome.tabs.sendMessage(sourceTab.id, { type: 'extract-console-network' });
  return {
    sourceUrl: sourceTab.url || sourceUrl || null,
    consoleLogs: logsResponse?.consoleLogs?.length ? logsResponse.consoleLogs : null,
    networkLogs: logsResponse?.networkLogs?.length ? logsResponse.networkLogs : null,
    deviceMeta: logsResponse?.deviceMeta || null,
  };
}

function setUploadButtonsState({ busy, activeButtonId = null }) {
  ['done-btn', 'upload-with-logs-btn'].forEach((buttonId) => {
    const button = document.getElementById(buttonId);
    if (!button) return;

    button.disabled = busy;

    if (!busy) {
      if (button.dataset.defaultHtml) {
        button.innerHTML = button.dataset.defaultHtml;
      }
      return;
    }

    if (!button.dataset.defaultHtml) {
      button.dataset.defaultHtml = button.innerHTML;
    }

    if (buttonId === activeButtonId) {
      button.innerHTML = '<span class="spinner"></span><span>Uploading...</span>';
    }
  });
}

// Copy to clipboard (flattened result)
async function copyToClipboard() {
  try {
    const blob = await engine.exportBlob('image/png');
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob })
    ]);

    // Visual feedback
    const btn = document.getElementById('copy-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span>✓</span><span>Copied!</span>';
    setTimeout(() => {
      btn.innerHTML = originalText;
    }, 2000);
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
    alert('Failed to copy to clipboard');
  }
}

// Save, upload, and navigate to the shared preview.
// The BASE image (crop applied, annotations NOT burned in) is uploaded along
// with the vector annotations, so the shared snapshot stays editable on the web.
async function finishEditing({ includeLogs = false } = {}) {
  const urlParams = new URLSearchParams(window.location.search);
  const captureId = urlParams.get('id');
  const activeButtonId = includeLogs ? 'upload-with-logs-btn' : 'done-btn';

  if (isTextInputActive()) {
    finalizeText(document.getElementById('text-input').value);
  }

  try {
    const baseBlob = await engine.exportBaseBlob('image/png');
    const annotations = engine.getAnnotations({ relativeToCrop: true });
    const annotationsJson = annotations.length > 0
      ? engine.serialize({ relativeToCrop: true })
      : null;

    // Get existing capture to preserve other data
    const existingCapture = await getCapture(captureId);
    if (!existingCapture) {
      throw new Error('Screenshot not found');
    }

    const storedConsoleLogs = existingCapture.consoleLogs || null;
    const storedNetworkLogs = existingCapture.networkLogs || null;
    let consoleLogs = storedConsoleLogs;
    let networkLogs = storedNetworkLogs;
    let sourceUrl = existingCapture.sourceUrl || null;
    let deviceMeta = existingCapture.deviceMeta || null;

    if (includeLogs) {
      try {
        const refreshedLogs = await collectLogsAndNetwork(sourceUrl);
        if (refreshedLogs) {
          consoleLogs = refreshedLogs.consoleLogs ?? consoleLogs;
          networkLogs = refreshedLogs.networkLogs ?? networkLogs;
          sourceUrl = refreshedLogs.sourceUrl ?? sourceUrl;
          deviceMeta = refreshedLogs.deviceMeta ?? deviceMeta;
        } else {
          console.warn('No eligible browser tab found for logs and network collection.');
        }
      } catch (logError) {
        console.warn('Failed to refresh logs and network data before upload:', logError);
      }
    }

    // Save to IndexedDB first (fallback safety) — base image + vector annotations
    await saveCapture(
      captureId,
      baseBlob,
      existingCapture.filename,
      'image/png',
      consoleLogs,
      networkLogs,
      sourceUrl,
      deviceMeta,
      annotationsJson
    );

    // Check if user is authenticated
    const authenticated = await isAuthenticated();
    if (!authenticated) {
      // Fallback to video.html preview
      window.location.href = `video.html?id=${captureId}`;
      return;
    }

    // Disable upload controls and show uploading state.
    setUploadButtonsState({ busy: true, activeButtonId });

    // Determine capture type
    let captureType = 'screenshot';
    if (existingCapture.filename.includes('recording')) {
      captureType = existingCapture.filename.includes('screen') ? 'screen-recording' : 'tab-recording';
    }

    const uploadConsoleLogs = includeLogs ? consoleLogs : null;
    const uploadNetworkLogs = includeLogs ? networkLogs : null;

    // Upload to Convex
    const result = await uploadToConvex(
      baseBlob,
      existingCapture.filename,
      'image/png',
      captureType,
      { sourceUrl: sourceUrl || undefined },
      uploadConsoleLogs,
      uploadNetworkLogs,
      deviceMeta,
      annotationsJson
    );

    // Build web app preview link
    const config = await getRuntimeConfig();
    const webAppUrl = config.siteUrl;
    const previewLink = `${webAppUrl}/#/snapshot/${result.shareToken}`;

    // Copy preview URL to clipboard
    try {
      await navigator.clipboard.writeText(previewLink);
      console.log('Preview link copied to clipboard');
    } catch (clipError) {
      console.warn('Could not copy to clipboard:', clipError);
      // Continue anyway - link will be accessible in browser
    }

    // Clean up IndexedDB since we've uploaded successfully
    try {
      await deleteCapture(captureId);
    } catch (dbError) {
      console.warn('Could not delete local capture:', dbError);
    }

    // Navigate to web app preview
    window.location.href = previewLink;

  } catch (error) {
    console.error('Failed to save/upload edited screenshot:', error);
    setUploadButtonsState({ busy: false });

    // Try to fallback to video.html preview if we saved locally
    const fallbackUrl = `video.html?id=${captureId}`;
    const shouldViewFallback = await showConfirmDialog({
      title: 'Upload failed',
      message: 'Would you like to open the local preview instead?',
      confirmLabel: 'Open preview',
      cancelLabel: 'Stay here'
    });

    if (shouldViewFallback) {
      window.location.href = fallbackUrl;
    }
  }
}

function showConfirmDialog({
  title,
  message,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel'
}) {
  const overlay = document.getElementById('confirm-overlay');
  const titleEl = document.getElementById('confirm-title');
  const messageEl = document.getElementById('confirm-message');
  const confirmBtn = document.getElementById('confirm-ok-btn');
  const cancelBtn = document.getElementById('confirm-cancel-btn');

  if (!overlay || !titleEl || !messageEl || !confirmBtn || !cancelBtn) {
    console.warn('Confirm dialog elements are missing');
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

// Event listeners
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
document.getElementById('done-btn').addEventListener('click', () => finishEditing());
document.getElementById('upload-with-logs-btn').addEventListener('click', () => finishEditing({ includeLogs: true }));

// Color picker
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const color = e.currentTarget.dataset.color;
    engine.setColor(color);
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
  });
});

// Thickness control
const thicknessSlider = document.getElementById('thickness-slider');
const thicknessValue = document.getElementById('thickness-value');
if (thicknessSlider && thicknessValue) {
  thicknessSlider.addEventListener('input', (e) => {
    const thickness = parseInt(e.target.value, 10);
    engine.setThickness(thickness);
    thicknessValue.textContent = thickness + 'px';
  });
}

// Font size control
const fontSizeSlider = document.getElementById('font-size-slider');
const fontSizeValue = document.getElementById('font-size-value');
if (fontSizeSlider && fontSizeValue) {
  fontSizeSlider.addEventListener('input', (e) => {
    const fontSize = parseInt(e.target.value, 10);
    engine.setFontSize(fontSize);
    fontSizeValue.textContent = fontSize + 'px';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  init();
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
