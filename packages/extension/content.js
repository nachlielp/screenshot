// ── Inject page-interceptors.js into the page's MAIN world ─────────────────
// Uses an external script (bypasses CSP restrictions that block inline scripts)
(function injectInterceptors() {
    if (document.getElementById('__screenshot_interceptors')) return;
    try {
        const s = document.createElement('script');
        s.id = '__screenshot_interceptors';
        s.src = chrome.runtime.getURL('page-interceptors.js');
        const target = document.documentElement || document.head || document.body;
        if (target) {
            target.prepend(s);
        } else {
            // Fallback: wait for DOM to exist
            document.addEventListener('DOMContentLoaded', () => {
                (document.head || document.documentElement).prepend(s);
            });
        }
    } catch (e) {
        // Extension context may be invalidated
    }
})();

/**
 * Creates a draggable iframe inside a wrapper div with a transparent overlay for drag handling.
 * 
 * @param {string} id - The ID of the wrapper element.
 * @param {string} src - The source URL of the iframe content.
 * @param {string} styles - The CSS styles for the wrapper element.
 * @return {HTMLElement} - The draggable wrapper element containing the iframe.
 */
const createDraggableIframe = (id, src, styles) => {
    const wrapper = document.createElement('div');
    wrapper.id = id;
    wrapper.style.cssText = styles;

    const iframe = document.createElement('iframe');
    iframe.setAttribute('allow', 'camera; microphone');
    iframe.src = src;
    iframe.style.cssText = `
        width: 100%;
        height: 100%;
        border-radius: 50%;
        border: none;
        pointer-events: auto;
    `;

    const dragOverlay = document.createElement('div');
    dragOverlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        cursor: grab;
        z-index: 2;
        background: transparent;
    `;

    const resizeHandle = document.createElement('div');
    resizeHandle.style.cssText = `
        position: absolute;
        bottom: 0;
        right: 0;
        width: 10px;
        height: 10px;
        cursor: nwse-resize;
        z-index: 1000;
        background: black;
        border: 2px solid black;
        color: black;
        clip-path: polygon(75% 0%, 100% 50%, 75% 100%, 0% 100%, 25% 50%, 0% 0%);
    `;

    let isDragging = false;
    let dragOffsetX, dragOffsetY;

    dragOverlay.addEventListener('mousedown', (event) => {
        isDragging = true;
        dragOffsetX = event.clientX - wrapper.offsetLeft;
        dragOffsetY = event.clientY - wrapper.offsetTop;
        dragOverlay.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (event) => {
        if (isDragging) {
            wrapper.style.left = `${event.clientX - dragOffsetX}px`;
            wrapper.style.top = `${event.clientY - dragOffsetY}px`;
        }
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            dragOverlay.style.cursor = 'grab';
        }
    });

    let isResizing = false;
    let initialWidth, initialHeight, initialMouseX, initialMouseY;

    resizeHandle.addEventListener('mousedown', (event) => {
        isResizing = true;
        initialWidth = wrapper.offsetWidth;
        initialHeight = wrapper.offsetHeight;
        initialMouseX = event.clientX;
        initialMouseY = event.clientY;
        event.stopPropagation(); // Prevent triggering drag
    });

    document.addEventListener('mousemove', (event) => {
        if (isResizing) {
            const newWidth = initialWidth + (event.clientX - initialMouseX);
            const newHeight = initialHeight + (event.clientY - initialMouseY);
            wrapper.style.width = `${Math.max(newWidth, 50)}px`; // Minimum width: 50px
            wrapper.style.height = `${Math.max(newHeight, 50)}px`; // Minimum height: 50px
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
        }
    });

    wrapper.appendChild(iframe);
    wrapper.appendChild(dragOverlay);
    wrapper.appendChild(resizeHandle);
    return wrapper;
};



// Listen for messages from service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'extract-console-network') {
        // Ask the main-world interceptor for buffered logs
        console.log('[content.js] Requesting console/network logs from page interceptor');
        
        const timeout = setTimeout(() => {
            console.warn('[content.js] Timeout waiting for logs response, returning empty arrays');
            sendResponse({ consoleLogs: [], networkLogs: [], deviceMeta: null });
        }, 3000);

        const handler = (event) => {
            if (event.source !== window) return;
            if (event.data && event.data.type === '__SCREENSHOT_LOGS_RESPONSE__') {
                console.log('[content.js] Received logs response:', {
                    consoleCount: event.data.consoleLogs?.length || 0,
                    networkCount: event.data.networkLogs?.length || 0,
                    hasMeta: !!event.data.deviceMeta
                });
                window.removeEventListener('message', handler);
                clearTimeout(timeout);
                sendResponse({
                    consoleLogs: event.data.consoleLogs || [],
                    networkLogs: event.data.networkLogs || [],
                    deviceMeta: event.data.deviceMeta || null,
                });
            }
        };
        window.addEventListener('message', handler);
        window.postMessage({ type: '__SCREENSHOT_GET_LOGS__' }, '*');
        
        return true; // async
    }

    if (request.type === 'capture-full-page') {
        // Capture full page screenshot by scrolling and stitching
        console.log('[content.js] Starting full page screenshot capture');
        
        (async () => {
            try {
                const dataUrl = await captureFullPageScreenshot();
                sendResponse({ dataUrl });
            } catch (error) {
                console.error('[content.js] Full page capture error:', error);
                sendResponse({ dataUrl: null, error: error.message });
            }
        })();
        
        return true; // async
    }
});

// Helper: force-scroll and wait until the browser has actually painted at the new position
function forceScrollAndWait(x, y) {
    return new Promise(resolve => {
        // Override smooth-scroll behavior temporarily
        const htmlEl = document.documentElement;
        const prevBehavior = htmlEl.style.scrollBehavior;
        htmlEl.style.scrollBehavior = 'auto';

        window.scrollTo({ left: x, top: y, behavior: 'instant' });

        htmlEl.style.scrollBehavior = prevBehavior;

        // Wait two animation frames (one to
        // commit the scroll, one to paint) + a small safety buffer
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                setTimeout(resolve, 80);
            });
        });
    });
}

// Function to capture full page screenshot
async function captureFullPageScreenshot() {
    console.log('[content.js] captureFullPageScreenshot started');

    const originalScrollX = window.scrollX;
    const originalScrollY = window.scrollY;

    // Get page dimensions (CSS pixels)
    const body = document.body;
    const html = document.documentElement;
    const pageWidth = Math.max(
        body.scrollWidth, body.offsetWidth,
        html.clientWidth, html.scrollWidth, html.offsetWidth
    );
    const pageHeight = Math.max(
        body.scrollHeight, body.offsetHeight,
        html.clientHeight, html.scrollHeight, html.offsetHeight
    );

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    console.log(`[content.js] Full page: ${pageWidth}x${pageHeight}, viewport: ${viewportWidth}x${viewportHeight}`);

    // Build a list of exact scroll-Y positions that guarantee full vertical
    // coverage with no gaps.  We advance by viewportHeight each time, but
    // the browser caps the last scroll at (pageHeight - viewportHeight).
    // If that cap would leave a gap we add the capped position as well.
    const yPositions = [];
    for (let y = 0; y < pageHeight; y += viewportHeight) {
        yPositions.push(y);
    }
    // The browser can never scroll past this maximum
    const maxScrollY = Math.max(0, pageHeight - viewportHeight);
    // Make sure the last entry is the max scroll position (covers the page bottom)
    if (yPositions.length === 0 || yPositions[yPositions.length - 1] < maxScrollY) {
        yPositions.push(maxScrollY);
    }

    // Same for horizontal
    const xPositions = [];
    for (let x = 0; x < pageWidth; x += viewportWidth) {
        xPositions.push(x);
    }
    const maxScrollX = Math.max(0, pageWidth - viewportWidth);
    if (xPositions.length === 0 || xPositions[xPositions.length - 1] < maxScrollX) {
        xPositions.push(maxScrollX);
    }

    const totalCaptures = xPositions.length * yPositions.length;
    console.log(`[content.js] Captures needed: ${xPositions.length} cols x ${yPositions.length} rows = ${totalCaptures}`);

    // Create canvas at CSS-pixel size
    const canvas = document.createElement('canvas');
    canvas.width = pageWidth;
    canvas.height = pageHeight;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pageWidth, pageHeight);

    let captureCount = 0;

    // Process rows top-to-bottom (later rows overwrite overlapping areas,
    // which is fine — they just re-draw the same content).
    for (const targetY of yPositions) {
        for (const targetX of xPositions) {
            // Force instant scroll & wait for paint
            await forceScrollAndWait(targetX, targetY);

            const actualX = Math.round(window.scrollX);
            const actualY = Math.round(window.scrollY);

            console.log(`[content.js] Capture ${captureCount + 1}/${totalCaptures}  target(${targetX},${targetY})  actual(${actualX},${actualY})`);

            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'capture-viewport-part'
                });

                if (response && response.dataUrl) {
                    const img = new Image();
                    await new Promise((resolve, reject) => {
                        img.onload = resolve;
                        img.onerror = reject;
                        img.src = response.dataUrl;
                    });

                    // captureVisibleTab returns an image at DPR resolution
                    // (e.g. 2x on Retina). Draw it scaled down to CSS-pixel
                    // viewport size, positioned at the actual scroll offset.
                    ctx.drawImage(img, actualX, actualY, viewportWidth, viewportHeight);
                    captureCount++;
                } else {
                    console.error(`[content.js] No dataUrl for section ${captureCount + 1}`);
                }
            } catch (error) {
                console.error(`[content.js] Error capturing section ${captureCount + 1}:`, error);
            }
        }
    }

    // Restore original scroll position
    await forceScrollAndWait(originalScrollX, originalScrollY);

    console.log(`[content.js] Full page capture complete. ${captureCount}/${totalCaptures} sections captured`);

    return canvas.toDataURL('image/png');
}
