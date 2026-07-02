// Convex client for Chrome Extension
import { getAuthToken, refreshAuthToken, getCurrentUser, isAuthenticated } from './auth.js';
import { getRuntimeConfig } from './runtime-config.js';

function compactObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined && value !== null)
  );
}

function decodeJwtPayload(token) {
  try {
    const parts = token?.split(".");
    if (parts?.length !== 3) {
      return null;
    }

    return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

async function getFriendlyConvexAuthError(status, errorBody, token) {
  if (status !== 401 || !errorBody.includes('"code":"NoAuthProvider"')) {
    return null;
  }

  const payload = decodeJwtPayload(token);
  const { convexUrl } = await getRuntimeConfig();
  const issuer = payload?.iss || "unknown";

  return [
    "Convex rejected the Clerk token because the deployment is configured for a different auth provider.",
    `Token issuer: ${issuer}`,
    `Convex deployment: ${convexUrl}`,
    "Update the active Convex deployment to trust this Clerk issuer, for example:",
    `npx convex env set CLERK_ISSUER ${issuer}`,
    "Then restart `npx convex dev` so the auth config reloads.",
  ].join(" ");
}

/**
 * Single entry point for Convex HTTP API calls.
 * Fetches a fresh token per call (tokens expire in ~60s, so a token minted at
 * the start of a long upload is stale by the time the final mutation runs)
 * and retries once on 401 after a forced refresh.
 */
async function convexCall(kind, path, args, { authenticated = true } = {}) {
  const { convexUrl } = await getRuntimeConfig();

  const doFetch = async (token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return fetch(`${convexUrl}/api/${kind}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path, args }),
    });
  };

  let token = null;
  if (authenticated) {
    token = await getAuthToken();
    if (!token) {
      throw new Error('You must be signed in');
    }
  }

  let response = await doFetch(token);

  if (response.status === 401 && authenticated) {
    console.warn(`Convex call ${path} got 401, refreshing token and retrying once`);
    token = await refreshAuthToken();
    if (token) {
      response = await doFetch(token);
    }
  }

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Convex ${kind} ${path} failed:`, response.status, errorBody);
    const friendlyError = await getFriendlyConvexAuthError(response.status, errorBody, token);
    throw new Error(friendlyError || `Convex ${path} failed: ${response.status} - ${errorBody}`);
  }

  return response.json();
}

export async function convexMutation(path, args, options) {
  return convexCall('mutation', path, args, options);
}

export async function convexQuery(path, args, options) {
  return convexCall('query', path, args, options);
}

function getUploadArgs(storageId, consoleLogsStorageId, networkLogsStorageId, filename, mimeType, blob, type, metadata, deviceMeta, annotations) {
  return compactObject({
    storageId,
    consoleLogsStorageId,
    networkLogsStorageId,
    filename,
    mimeType,
    fileSize: blob.size,
    type,
    annotations,
    ...metadata,
    // Device metadata is optional and may not be accepted by older Convex deployments.
    deviceBrowser: deviceMeta?.browser,
    deviceBrowserVersion: deviceMeta?.browserVersion,
    deviceOs: deviceMeta?.os,
    devicePlatform: deviceMeta?.platform,
    deviceNetworkSpeed: deviceMeta?.networkSpeed,
    deviceCharging: deviceMeta?.charging,
    deviceBrowserMode: deviceMeta?.browserMode,
    deviceScreenWidth: deviceMeta?.screenWidth,
    deviceScreenHeight: deviceMeta?.screenHeight,
    deviceViewportWidth: deviceMeta?.viewportWidth,
    deviceViewportHeight: deviceMeta?.viewportHeight,
    devicePixelRatio: deviceMeta?.devicePixelRatio,
    deviceUserAgent: deviceMeta?.userAgent,
    deviceLanguage: deviceMeta?.language,
    captureTimestamp: deviceMeta?.timestamp,
  });
}

function getExtraFieldFromConvexError(errorMessage) {
  const match = errorMessage?.match(/Object contains extra field `([^`]+)`/);
  return match?.[1] || null;
}

async function ensureConvexUser(user) {
  await convexMutation('screenshots:getOrCreateUser', {
    clerkId: user.id,
    email: user.primaryEmailAddress?.emailAddress || user.emailAddresses?.[0]?.emailAddress || user.email || '',
    name: user.fullName || user.firstName || undefined,
  });
}

/**
 * Uploads a blob to Convex storage and returns its storage id.
 * Generates a fresh upload URL (and token) right before the upload so long
 * multi-file uploads don't outlive the auth token.
 */
export async function uploadBlobToStorage(blob, mimeType) {
  const { value: uploadUrl } = await convexMutation('screenshots:generateUploadUrl', {});

  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    body: blob,
    headers: {
      'Content-Type': mimeType,
    },
  });

  if (!uploadResponse.ok) {
    throw new Error('Failed to upload file to storage');
  }

  const { storageId } = await uploadResponse.json();
  return storageId;
}

/**
 * Serializes an array of log entries to JSON and uploads it to storage.
 * Returns the storage id, or undefined when the upload fails (logs are
 * best-effort — the capture itself should still be saved).
 */
async function uploadLogsToStorage(entries, label) {
  if (!entries || entries.length === 0) {
    return undefined;
  }

  try {
    const blob = new Blob([JSON.stringify(entries)], { type: 'application/json' });
    const storageId = await uploadBlobToStorage(blob, 'application/json');
    console.log(`${label} logs uploaded:`, storageId);
    return storageId;
  } catch (error) {
    console.error(`Error uploading ${label} logs (continuing without them):`, error);
    return undefined;
  }
}

async function getAuthenticatedConvexContext() {
  const authenticated = await isAuthenticated();
  if (!authenticated) {
    throw new Error('You must be signed in to upload');
  }

  const user = await getCurrentUser();
  if (!user) {
    throw new Error('Failed to get authentication credentials');
  }

  await ensureConvexUser(user);

  return { user };
}

async function createScreenshotRecord(args) {
  const ignoredFields = [];
  let currentArgs = { ...args };

  while (true) {
    const screenshotData = await convexMutation('screenshots:uploadScreenshot', currentArgs);

    if (screenshotData.status !== 'error') {
      if (ignoredFields.length > 0) {
        console.warn('Convex deployment rejected optional upload fields, saved without:', ignoredFields);
      }
      return screenshotData;
    }

    const extraField = getExtraFieldFromConvexError(screenshotData.errorMessage);
    if (!extraField || !(extraField in currentArgs)) {
      throw new Error(`Convex error: ${screenshotData.errorMessage}`);
    }

    ignoredFields.push(extraField);
    console.warn(`Convex deployment rejected field "${extraField}", retrying without it`);
    const { [extraField]: _removed, ...nextArgs } = currentArgs;
    currentArgs = nextArgs;
  }
}

/**
 * Upload a file to Convex storage
 * @param {Blob} blob - The file blob to upload
 * @param {string} filename - The filename
 * @param {string} mimeType - The MIME type
 * @param {string} type - The capture type (screenshot, tab-recording, screen-recording)
 * @param {object} metadata - Optional metadata (width, height, duration)
 * @returns {Promise<{shareUrl: string, publicUrl: string}>}
 */
export async function uploadToConvex(blob, filename, mimeType, type, metadata = {}, consoleLogs = null, networkLogs = null, deviceMeta = null, annotations = null) {
  try {
    const { user } = await getAuthenticatedConvexContext();
    console.log('Uploading as:', user.email);

    const storageId = await uploadBlobToStorage(blob, mimeType);
    const consoleLogsStorageId = await uploadLogsToStorage(consoleLogs, 'Console');
    const networkLogsStorageId = await uploadLogsToStorage(networkLogs, 'Network');

    const screenshotArgs = getUploadArgs(
      storageId,
      consoleLogsStorageId,
      networkLogsStorageId,
      filename,
      mimeType,
      blob,
      type,
      metadata,
      deviceMeta,
      annotations
    );
    const screenshotData = await createScreenshotRecord(screenshotArgs);

    // Convex HTTP API returns { status: "success", value: ... } or just the value
    const result = screenshotData.value || screenshotData;

    console.log('Upload successful:', result);

    return {
      shareUrl: result.publicUrl || '',
      publicUrl: result.publicUrl || '',
      consoleLogsUrl: result.consoleLogsUrl || null,
      networkLogsUrl: result.networkLogsUrl || null,
      shareToken: result.shareToken || '',
      expiresAt: result.expiresAt || null,
    };
  } catch (error) {
    console.error('Error uploading to Convex:', error);
    throw error;
  }
}

export async function uploadSlideshowToConvex(session) {
  if (!session || !Array.isArray(session.frames) || session.frames.length === 0) {
    throw new Error('Slideshow draft is empty');
  }

  try {
    await getAuthenticatedConvexContext();
    const uploadedFrames = [];

    for (const frame of session.frames) {
      const capture = frame.capture;
      const blob = capture?.blob;
      const mimeType = capture?.mimeType || frame.mimeType || 'image/png';
      const filename = capture?.filename || frame.filename || `frame-${frame.order}.png`;

      if (!blob) {
        throw new Error(`Missing frame data for ${filename}`);
      }

      const storageId = await uploadBlobToStorage(blob, mimeType);

      uploadedFrames.push({
        storageId,
        filename,
        mimeType,
        width: frame.width || undefined,
        height: frame.height || undefined,
        sourceUrl: frame.sourceUrl || capture?.sourceUrl || undefined,
        captureTimestamp: frame.captureTimestamp || capture?.deviceMeta?.timestamp || undefined,
        hidden: Boolean(frame.hidden),
        order: frame.order,
      });
    }

    const payload = await convexMutation('slideshows:uploadSlideshow', {
      title: session.title,
      frames: uploadedFrames,
    });

    if (payload.status === 'error') {
      throw new Error(`Failed to create slideshow record: ${payload.errorMessage}`);
    }

    const result = payload.value || payload;
    const { siteUrl } = await getRuntimeConfig();

    return {
      shareToken: result.shareToken || '',
      shareUrl: `${siteUrl}/#/slideshow/${result.shareToken}`,
      coverPublicUrl: result.coverPublicUrl || '',
      frameCount: result.frameCount || uploadedFrames.length,
      visibleFrameCount: result.visibleFrameCount || uploadedFrames.filter((frame) => !frame.hidden).length,
    };
  } catch (error) {
    console.error('Error uploading slideshow to Convex:', error);
    throw error;
  }
}

/**
 * Get screenshot by share token
 * @param {string} shareToken - The share token
 * @returns {Promise<object|null>}
 */
export async function getScreenshotByToken(shareToken) {
  try {
    const { value } = await convexQuery('screenshots:getScreenshotByToken', { shareToken }, { authenticated: false });
    return value;
  } catch (error) {
    console.error('Error getting screenshot:', error);
    return null;
  }
}

/**
 * Get user's screenshots
 * @param {number} limit - Maximum number of screenshots to fetch
 * @returns {Promise<Array>}
 */
export async function getUserScreenshots(limit = 100) {
  const authenticated = await isAuthenticated();
  if (!authenticated) {
    return [];
  }

  try {
    const { value } = await convexQuery('screenshots:getUserScreenshots', { limit });
    return value || [];
  } catch (error) {
    console.error('Error getting user screenshots:', error);
    return [];
  }
}

/**
 * Delete a screenshot
 * @param {string} screenshotId - The screenshot ID
 * @returns {Promise<void>}
 */
export async function deleteScreenshot(screenshotId) {
  const authenticated = await isAuthenticated();
  if (!authenticated) {
    throw new Error('You must be signed in to delete');
  }

  await convexMutation('screenshots:deleteScreenshot', { id: screenshotId });
}
