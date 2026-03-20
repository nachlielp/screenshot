// Convex client for Chrome Extension
import { getAuthToken, getCurrentUser, isAuthenticated } from './auth.js';
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

function getUploadArgs(storageId, consoleLogsStorageId, networkLogsStorageId, filename, mimeType, blob, type, metadata, deviceMeta) {
  return compactObject({
    storageId,
    consoleLogsStorageId,
    networkLogsStorageId,
    filename,
    mimeType,
    fileSize: blob.size,
    type,
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

async function createScreenshotRecord(token, args) {
  const { convexUrl } = await getRuntimeConfig();
  const ignoredFields = [];
  let currentArgs = { ...args };

  while (true) {
    const screenshotResponse = await fetch(`${convexUrl}/api/mutation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        path: 'screenshots:uploadScreenshot',
        args: currentArgs,
      }),
    });

    if (!screenshotResponse.ok) {
      const errorBody = await screenshotResponse.text();
      console.error('Screenshot record failed:', screenshotResponse.status, errorBody);
      throw new Error('Failed to create screenshot record');
    }

    const screenshotData = await screenshotResponse.json();
    console.log('Screenshot response data:', JSON.stringify(screenshotData));

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
export async function uploadToConvex(blob, filename, mimeType, type, metadata = {}, consoleLogs = null, networkLogs = null, deviceMeta = null) {
  // Check if authenticated
  const authenticated = await isAuthenticated();
  if (!authenticated) {
    throw new Error('You must be signed in to upload');
  }

  try {
    const { convexUrl } = await getRuntimeConfig();
    const user = await getCurrentUser();
    const token = await getAuthToken();
    
    if (!user || !token) {
      throw new Error('Failed to get authentication credentials');
    }
    
    console.log('Upload auth - user:', user.email, 'token length:', token?.length, 'token prefix:', token?.substring(0, 20));
    
    // Debug: decode and log the JWT payload
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        console.log('JWT claims:', JSON.stringify(payload, null, 2));
        console.log('JWT issuer:', payload.iss);
        console.log('JWT audience:', payload.aud);
        console.log('JWT subject:', payload.sub);
        console.log('JWT exp:', new Date(payload.exp * 1000).toISOString());
      }
    } catch (e) {
      console.log('Could not decode JWT:', e);
    }

    // Step 1: Get or create user in Convex
    const userResponse = await fetch(`${convexUrl}/api/mutation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        path: 'screenshots:getOrCreateUser',
        args: {
          clerkId: user.id,
          email: user.primaryEmailAddress?.emailAddress || user.emailAddresses?.[0]?.emailAddress || user.email || '',
          name: user.fullName || user.firstName || undefined,
        },
      }),
    });

    if (!userResponse.ok) {
      const errorBody = await userResponse.text();
      console.error('Convex mutation failed:', userResponse.status, errorBody);
      const friendlyError = await getFriendlyConvexAuthError(userResponse.status, errorBody, token);
      throw new Error(
        friendlyError || `Failed to create/get user in Convex: ${userResponse.status} - ${errorBody}`
      );
    }

    // Step 2: Generate upload URL for main file
    const uploadUrlResponse = await fetch(`${convexUrl}/api/mutation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        path: 'screenshots:generateUploadUrl',
        args: {},
      }),
    });

    if (!uploadUrlResponse.ok) {
      throw new Error('Failed to generate upload URL');
    }

    const { value: uploadUrl } = await uploadUrlResponse.json();

    // Step 3: Upload main file to Convex storage
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
    
    // Step 3.5: Upload console logs if provided
    let consoleLogsStorageId = undefined;
    if (consoleLogs && consoleLogs.length > 0) {
      try {
        const consoleUploadUrlResponse = await fetch(`${convexUrl}/api/mutation`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            path: 'screenshots:generateUploadUrl',
            args: {},
          }),
        });

        if (consoleUploadUrlResponse.ok) {
          const { value: consoleUploadUrl } = await consoleUploadUrlResponse.json();
          const consoleBlob = new Blob([JSON.stringify(consoleLogs)], { type: 'application/json' });
          const consoleUploadResponse = await fetch(consoleUploadUrl, {
            method: 'POST',
            body: consoleBlob,
            headers: { 'Content-Type': 'application/json' },
          });

          if (consoleUploadResponse.ok) {
            const consoleResult = await consoleUploadResponse.json();
            consoleLogsStorageId = consoleResult.storageId;
            console.log('Console logs uploaded:', consoleLogsStorageId);
          }
        }
      } catch (consoleError) {
        console.error('Error uploading console logs (continuing without them):', consoleError);
      }
    }

    // Step 3.6: Upload network logs if provided
    let networkLogsStorageId = undefined;
    if (networkLogs && networkLogs.length > 0) {
      try {
        const networkUploadUrlResponse = await fetch(`${convexUrl}/api/mutation`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            path: 'screenshots:generateUploadUrl',
            args: {},
          }),
        });

        if (networkUploadUrlResponse.ok) {
          const { value: networkUploadUrl } = await networkUploadUrlResponse.json();
          const networkBlob = new Blob([JSON.stringify(networkLogs)], { type: 'application/json' });
          const networkUploadResponse = await fetch(networkUploadUrl, {
            method: 'POST',
            body: networkBlob,
            headers: { 'Content-Type': 'application/json' },
          });

          if (networkUploadResponse.ok) {
            const networkResult = await networkUploadResponse.json();
            networkLogsStorageId = networkResult.storageId;
            console.log('Network logs uploaded:', networkLogsStorageId);
          }
        }
      } catch (networkError) {
        console.error('Error uploading network logs (continuing without them):', networkError);
      }
    }

    // Step 4: Create screenshot record in database
    const screenshotArgs = getUploadArgs(
      storageId,
      consoleLogsStorageId,
      networkLogsStorageId,
      filename,
      mimeType,
      blob,
      type,
      metadata,
      deviceMeta
    );
    const screenshotData = await createScreenshotRecord(token, screenshotArgs);
    
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

function generateShareToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Get screenshot by share token
 * @param {string} shareToken - The share token
 * @returns {Promise<object|null>}
 */
export async function getScreenshotByToken(shareToken) {
  try {
    const { convexUrl } = await getRuntimeConfig();
    const response = await fetch(`${convexUrl}/api/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: 'screenshots:getScreenshotByToken',
        args: { shareToken },
      }),
    });

    if (!response.ok) return null;
    
    const { value } = await response.json();
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
    const { convexUrl } = await getRuntimeConfig();
    const token = await getAuthToken();
    
    const response = await fetch(`${convexUrl}/api/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        path: 'screenshots:getUserScreenshots',
        args: { limit },
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to fetch screenshots');
    }

    const { value } = await response.json();
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

  try {
    const { convexUrl } = await getRuntimeConfig();
    const token = await getAuthToken();
    
    const response = await fetch(`${convexUrl}/api/mutation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        path: 'screenshots:deleteScreenshot',
        args: { id: screenshotId },
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to delete screenshot');
    }
  } catch (error) {
    console.error('Error deleting screenshot:', error);
    throw error;
  }
}
