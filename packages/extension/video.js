import { getCapture, deleteCapture } from './utils/db.js';
import { uploadToConvex } from './utils/convex-client.js';
import { isAuthenticated } from './utils/auth.js';
import { getRuntimeConfig } from './utils/runtime-config.js';

const VERSION = 'v1.3.0';
console.log(`[Video] Module loaded - ${VERSION}`);

const previewContainer = document.getElementById('preview');
const downloadBtn = document.getElementById('downloadBtn');
const downloadConsoleBtn = document.getElementById('downloadConsoleBtn');
const downloadNetworkBtn = document.getElementById('downloadNetworkBtn');
const shareBtn = document.getElementById('shareBtn');
const shareText = document.getElementById('shareText');
const linkDisplay = document.getElementById('linkDisplay');
const errorDiv = document.getElementById('error');

let currentCapture = null;
let blobUrl = null;

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
      const video = document.createElement('video');
      video.src = blobUrl;
      video.controls = true;
      video.autoplay = true;
      video.loop = true;
      previewContainer.appendChild(video);
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
