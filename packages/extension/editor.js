import { getCapture, saveCapture, deleteCapture } from './utils/db.js';
import { uploadToConvex } from './utils/convex-client.js';
import { isAuthenticated } from './utils/auth.js';

// Editor state
let canvas, ctx;
let originalImage = null;
let currentTool = null;
let currentColor = '#ef4444';
let currentThickness = 3;
let currentFontSize = 20;
let isDrawing = false;
let startX, startY;
let tempCanvas, tempCtx;

// History management
let history = [];
let historyIndex = -1;
const MAX_HISTORY = 50;

// Crop selection
let cropSelection = null;

// Text input
let textInputActive = false;
let activeConfirmCleanup = null;

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

    await loadImageToCanvas(capture.blob);
    document.getElementById('loading').style.display = 'none';
    document.getElementById('toolbar-header').style.display = 'flex';
    
    // Save initial state
    saveHistory();
  } catch (error) {
    console.error('Failed to load screenshot:', error);
    alert('Failed to load screenshot');
  }
}

// Load image blob to canvas
async function loadImageToCanvas(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      canvas = document.getElementById('editor-canvas');
      ctx = canvas.getContext('2d', { willReadFrequently: true });

      // Set canvas size to image size
      canvas.width = img.width;
      canvas.height = img.height;

      // Draw the image
      ctx.drawImage(img, 0, 0);

      originalImage = img;
      URL.revokeObjectURL(url);

      // Create temporary canvas for preview
      tempCanvas = document.createElement('canvas');
      tempCtx = tempCanvas.getContext('2d');

      resolve();
    };

    img.onerror = reject;
    img.src = url;
  });
}

// History management
function saveHistory() {
  // Remove any forward history
  if (historyIndex < history.length - 1) {
    history = history.slice(0, historyIndex + 1);
  }

  // Save current state
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  history.push({
    imageData,
    width: canvas.width,
    height: canvas.height
  });

  // Limit history size
  if (history.length > MAX_HISTORY) {
    history.shift();
  } else {
    historyIndex++;
  }

  updateHistoryButtons();
}

function undo() {
  if (historyIndex > 0) {
    historyIndex--;
    restoreFromHistory();
    updateHistoryButtons();
  }
}

function redo() {
  if (historyIndex < history.length - 1) {
    historyIndex++;
    restoreFromHistory();
    updateHistoryButtons();
  }
}

function restoreFromHistory() {
  const state = history[historyIndex];
  canvas.width = state.width;
  canvas.height = state.height;
  ctx.putImageData(state.imageData, 0, 0);
}

function updateHistoryButtons() {
  document.getElementById('undo-btn').disabled = historyIndex <= 0;
  document.getElementById('redo-btn').disabled = historyIndex >= history.length - 1;
}

// Tool selection
function selectTool(tool) {
  // Deactivate previous tool
  document.querySelectorAll('.tool-btn').forEach(btn => {
    if (!btn.id.includes('undo') && !btn.id.includes('redo') && 
        !btn.id.includes('copy') && !btn.id.includes('done')) {
      btn.classList.remove('active');
    }
  });

  if (currentTool === tool) {
    currentTool = null;
    canvas.style.cursor = 'default';
  } else {
    currentTool = tool;
    document.getElementById(`${tool}-btn`).classList.add('active');
    canvas.style.cursor = 'crosshair';
  }
}

// Color selection
function selectColor(color) {
  currentColor = color;
  document.querySelectorAll('.color-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  event.target.classList.add('active');
}

// Canvas event handlers
function getCanvasCoordinates(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
  };
}

function handleMouseDown(e) {
  if (!currentTool) return;
  
  // If text input is already active, ignore clicks
  if (textInputActive) return;

  const coords = getCanvasCoordinates(e);
  startX = coords.x;
  startY = coords.y;
  isDrawing = true;

  if (currentTool === 'text') {
    placeTextInput(e.clientX, e.clientY);
  } else {
    // Save current canvas state to temp for preview
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    tempCtx.drawImage(canvas, 0, 0);
  }
}

function handleMouseMove(e) {
  if (!isDrawing || !currentTool || currentTool === 'text') return;

  const coords = getCanvasCoordinates(e);

  // Restore from temp canvas
  ctx.drawImage(tempCanvas, 0, 0);

  // Draw preview
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

function handleMouseUp(e) {
  if (!isDrawing) return;
  isDrawing = false;

  if (!currentTool || currentTool === 'text') return;

  const coords = getCanvasCoordinates(e);

  if (currentTool === 'crop') {
    executeCrop(startX, startY, coords.x, coords.y);
  } else {
    // Finalize the drawing
    saveHistory();
  }
}

// Drawing functions
function drawRectangle(x1, y1, x2, y2) {
  const width = x2 - x1;
  const height = y2 - y1;
  ctx.strokeRect(x1, y1, width, height);
}

function drawArrow(x1, y1, x2, y2) {
  const headLength = 20;
  const angle = Math.atan2(y2 - y1, x2 - x1);

  // Draw line
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // Draw arrowhead
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
  // Draw dimmed overlay
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Clear crop area
  const width = x2 - x1;
  const height = y2 - y1;
  ctx.clearRect(x1, y1, width, height);
  ctx.drawImage(tempCanvas, x1, y1, width, height, x1, y1, width, height);

  // Draw crop border
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.strokeRect(x1, y1, width, height);
  ctx.setLineDash([]);
}

function executeCrop(x1, y1, x2, y2) {
  // Normalize coordinates
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  if (width < 10 || height < 10) {
    // Too small, cancel crop
    ctx.drawImage(tempCanvas, 0, 0);
    return;
  }

  // Get cropped image data
  const croppedData = ctx.getImageData(left, top, width, height);

  // Resize canvas
  canvas.width = width;
  canvas.height = height;

  // Draw cropped image
  ctx.putImageData(croppedData, 0, 0);

  saveHistory();
  selectTool(null); // Deselect crop tool
}

// Text input handling
function placeTextInput(clientX, clientY) {
  const overlay = document.getElementById('text-input-overlay');
  const input = document.getElementById('text-input');

  overlay.style.left = clientX + 'px';
  overlay.style.top = clientY + 'px';
  overlay.style.display = 'block';

  input.value = '';
  input.focus();

  textInputActive = true;
  isDrawing = false;

  // Prevent clicks on overlay from propagating to canvas
  overlay.onclick = (e) => {
    e.stopPropagation();
  };

  // Remove old listeners
  input.onkeydown = null;
  input.onblur = null;

  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finalizeText(clientX, clientY, input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelText();
    }
  };

  // Delay blur handler to prevent immediate triggering
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

// Copy to clipboard
async function copyToClipboard() {
  try {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
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

// Done - save, upload, and navigate to snapshot-inspector
async function finishEditing() {
  const urlParams = new URLSearchParams(window.location.search);
  const captureId = urlParams.get('id');
  const doneBtn = document.getElementById('done-btn');
  const originalBtnHtml = doneBtn.innerHTML;

  try {
    // Convert canvas to blob
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

    // Get existing capture to preserve other data
    const existingCapture = await getCapture(captureId);
    
    // Save to IndexedDB first (fallback safety)
    await saveCapture(
      captureId,
      blob,
      existingCapture.filename,
      'image/png',
      existingCapture.htmlSnapshot,
      existingCapture.consoleLogs,
      existingCapture.networkLogs,
      existingCapture.sourceUrl,
      existingCapture.deviceMeta
    );

    // Check if user is authenticated
    const authenticated = await isAuthenticated();
    if (!authenticated) {
      // Fallback to video.html preview
      window.location.href = `video.html?id=${captureId}`;
      return;
    }

    // Disable button and show uploading state
    doneBtn.disabled = true;
    doneBtn.innerHTML = '<span class="spinner"></span><span>Uploading...</span>';

    // Determine capture type
    let captureType = 'screenshot';
    if (existingCapture.filename.includes('recording')) {
      captureType = existingCapture.filename.includes('screen') ? 'screen-recording' : 'tab-recording';
    }

    // Upload to Convex
    const result = await uploadToConvex(
      blob,
      existingCapture.filename,
      'image/png',
      captureType,
      { sourceUrl: existingCapture.sourceUrl || undefined },
      existingCapture.htmlSnapshot || null,
      existingCapture.consoleLogs || null,
      existingCapture.networkLogs || null,
      existingCapture.deviceMeta || null
    );

    // Build web app preview link
    const webAppUrl = 'http://localhost:5173';
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
    // Restore button
    doneBtn.disabled = false;
    doneBtn.innerHTML = originalBtnHtml;
    
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
document.getElementById('undo-btn').addEventListener('click', undo);
document.getElementById('redo-btn').addEventListener('click', redo);
document.getElementById('crop-btn').addEventListener('click', () => selectTool('crop'));
document.getElementById('rectangle-btn').addEventListener('click', () => selectTool('rectangle'));
document.getElementById('arrow-btn').addEventListener('click', () => selectTool('arrow'));
document.getElementById('text-btn').addEventListener('click', () => selectTool('text'));
document.getElementById('copy-btn').addEventListener('click', copyToClipboard);
document.getElementById('done-btn').addEventListener('click', finishEditing);

// Color picker
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const color = e.currentTarget.dataset.color;
    selectColor(color);
  });
});

// Thickness control
const thicknessSlider = document.getElementById('thickness-slider');
const thicknessValue = document.getElementById('thickness-value');
if (thicknessSlider && thicknessValue) {
  thicknessSlider.addEventListener('input', (e) => {
    currentThickness = parseInt(e.target.value);
    thicknessValue.textContent = currentThickness + 'px';
  });
}

// Font size control
const fontSizeSlider = document.getElementById('font-size-slider');
const fontSizeValue = document.getElementById('font-size-value');
if (fontSizeSlider && fontSizeValue) {
  fontSizeSlider.addEventListener('input', (e) => {
    currentFontSize = parseInt(e.target.value);
    fontSizeValue.textContent = currentFontSize + 'px';
  });
}

// Canvas mouse events
document.addEventListener('DOMContentLoaded', () => {
  init();
  
  // Delay canvas event listeners until canvas is ready
  setTimeout(() => {
    canvas = document.getElementById('editor-canvas');
    if (canvas) {
      canvas.addEventListener('mousedown', handleMouseDown);
      canvas.addEventListener('mousemove', handleMouseMove);
      canvas.addEventListener('mouseup', handleMouseUp);
      canvas.addEventListener('mouseleave', handleMouseUp);
    }
  }, 100);
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (textInputActive) return;

  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    if (e.shiftKey) {
      redo();
    } else {
      undo();
    }
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
    e.preventDefault();
    copyToClipboard();
  } else if (e.key === 'Escape') {
    selectTool(null);
  }
});
