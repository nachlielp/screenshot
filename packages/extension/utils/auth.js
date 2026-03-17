// Clerk authentication for the Chrome extension
// Uses a hosted Clerk sign-in page plus cookie-based session sync
import { getRuntimeConfig } from "./runtime-config.js";

// Storage key for user data
const LEGACY_AUTH_STORAGE_KEY = 'clerk_auth';
let currentUser = null;
let authListeners = [];

async function getAuthStorageKey() {
  const config = await getRuntimeConfig();
  return `clerk_auth_${config.environment}`;
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

function isJwtExpired(token) {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) {
    return false;
  }

  return Date.now() >= payload.exp * 1000;
}

async function tokenMatchesRuntime(token) {
  if (!token) {
    return false;
  }

  const payload = decodeJwtPayload(token);
  if (!payload?.iss) {
    return true;
  }

  const config = await getRuntimeConfig();
  const validIssuers = new Set([
    config.clerkDomain,
    config.clerkApiDomain,
  ]);

  return validIssuers.has(payload.iss);
}

async function persistCurrentUser() {
  const authStorageKey = await getAuthStorageKey();
  await chrome.storage.local.set({ [authStorageKey]: currentUser });
}

export async function storeAuthData(userData) {
  currentUser = userData;
  await persistCurrentUser();
}

async function collectClerkCookies() {
  const config = await getRuntimeConfig();
  const allCookies = [];

  for (const domain of config.clerkCookieDomains) {
    const cookies = await chrome.cookies.getAll({ domain });
    allCookies.push(...cookies);
  }

  for (const url of config.clerkCookieUrls) {
    const cookies = await chrome.cookies.getAll({ url });
    allCookies.push(...cookies);
  }

  const seen = new Set();
  return allCookies.filter(cookie => {
    const key = `${cookie.domain}:${cookie.path}:${cookie.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function pickCookie(cookies, ...names) {
  const config = await getRuntimeConfig();

  for (const name of names) {
    const exactDomainMatch = cookies.find(cookie =>
      cookie.name === name &&
      config.exactCookieDomains.includes(cookie.domain.replace(/^\./, ""))
    );
    if (exactDomainMatch) {
      return exactDomainMatch;
    }

    const wildcardMatch = cookies.find(cookie => cookie.name === name);
    if (wildcardMatch) {
      return wildcardMatch;
    }
  }

  return null;
}

function extractSessionsFromClientData(clientData) {
  const candidates = [
    clientData?.response?.sessions,
    clientData?.sessions,
    clientData?.client?.sessions,
    clientData?.response?.client?.sessions,
    clientData?.response?.signed_in_sessions,
    clientData?.client?.signed_in_sessions,
  ];

  return candidates.find(Array.isArray) || [];
}

async function clearStoredAuth(notify = false) {
  const authStorageKey = await getAuthStorageKey();
  currentUser = null;
  await chrome.storage.local.remove([authStorageKey, LEGACY_AUTH_STORAGE_KEY]);
  if (notify) {
    notifyAuthChange(null);
  }
}

// Initialize auth by loading from storage
export async function initializeAuth() {
  try {
    const authStorageKey = await getAuthStorageKey();
    const result = await chrome.storage.local.get([authStorageKey]);
    if (result[authStorageKey]) {
      const storedUser = result[authStorageKey];

      if (!(await tokenMatchesRuntime(storedUser.token))) {
        console.warn('Stored auth issuer does not match the active environment. Clearing stale auth.');
        await clearStoredAuth(false);
        return;
      }

      currentUser = storedUser;
      console.log('Auth initialized from storage');
    } else {
      console.log('No stored auth found');
    }
  } catch (error) {
    console.error('Failed to initialize auth:', error);
  }
}

export async function isAuthenticated() {
  try {
    await initializeAuth();
    return !!currentUser && !!currentUser.token;
  } catch (error) {
    console.error('Error checking authentication:', error);
    return false;
  }
}

export async function getCurrentUser() {
  try {
    await initializeAuth();
    return currentUser;
  } catch (error) {
    console.error('Error getting current user:', error);
    return null;
  }
}

export async function getAuthToken() {
  try {
    await initializeAuth();
    
    // If token exists and not expired, return it
    if (currentUser?.token && currentUser?.tokenExpiry) {
      if (Date.now() < currentUser.tokenExpiry && !isJwtExpired(currentUser.token)) {
        console.log('Using cached token, expires in', Math.round((currentUser.tokenExpiry - Date.now()) / 1000), 'seconds');
        return currentUser.token;
      }
      console.log('Token expired, refreshing...');
    }
    
    // Token expired or doesn't exist, need to get a fresh one
    if (currentUser?.sessionId) {
      const freshToken = await getConvexToken(currentUser.sessionId);
      if (freshToken) {
        currentUser.token = freshToken;
        currentUser.tokenExpiry = Date.now() + (55 * 1000); // Clerk tokens expire in ~60s
        await persistCurrentUser();
        return freshToken;
      }

      console.warn('Stored Clerk session could not be refreshed, attempting session re-sync');

      try {
        const syncedUser = await syncClerkSession({ notify: false });
        if (syncedUser?.token) {
          return syncedUser.token;
        }
      } catch (syncError) {
        console.error('Session re-sync failed after token refresh error:', syncError);
      }

      console.warn('No active Clerk session was found during refresh. Clearing stored auth.');
      await clearStoredAuth(true);
    }
    
    console.log('No session to refresh token from');
    return null;
  } catch (error) {
    console.error('Error getting auth token:', error);
    return null;
  }
}

// Get a Convex-specific JWT from Clerk's Frontend API
async function getConvexToken(sessionId) {
  try {
    const config = await getRuntimeConfig();
    const uniqueCookies = await collectClerkCookies();
    
    console.log('Available cookies for token fetch:', uniqueCookies.map(c => `${c.name} (${c.domain})`));
    
    // Find the __clerk_db_jwt - needed for dev instance authentication
    const clerkDbJwt = await pickCookie(uniqueCookies, '__clerk_db_jwt');
    
    if (!clerkDbJwt) {
      console.error('No __clerk_db_jwt cookie found - cannot authenticate with Clerk dev instance');
      return null;
    }
    
    console.log('Found __clerk_db_jwt cookie from domain:', clerkDbJwt.domain);
    
    // For Clerk dev instances, pass __clerk_db_jwt as a query parameter
    // Chrome extensions can't send cookies via fetch to third-party domains
    const url = `${config.clerkApiDomain}/v1/client/sessions/${sessionId}/tokens/convex?__clerk_db_jwt=${encodeURIComponent(clerkDbJwt.value)}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      }
    });
    
    console.log('Convex token response status:', response.status);
    
    if (response.ok) {
      const data = await response.json();
      console.log('Got Convex JWT token, length:', data.jwt?.length);
      return data.jwt;
    } else {
      const text = await response.text();
      console.error('Failed to get Convex token:', response.status, text);
      return null;
    }
  } catch (error) {
    console.error('Error fetching Convex token:', error);
    return null;
  }
}

export async function signIn() {
  return signInWithGoogle(); // Default to Google sign-in
}

export async function signInWithGoogle() {
  try {
    const config = await getRuntimeConfig();
    // Open Clerk's sign-in page directly (not an extension page)
    const signInUrl = `${config.clerkDomain}/sign-in`;
    await chrome.tabs.create({ 
      url: signInUrl,
      active: true 
    });
    
    console.log('Opened Clerk sign-in page. After signing in, click "Sync Session" in the extension popup.');
    
    // Store the timestamp so we know when sign-in was initiated
    await chrome.storage.local.set({ 
      clerkSignInStarted: Date.now()
    });
    
    return null;
  } catch (error) {
    console.error('Error opening sign-in page:', error);
    throw error;
  }
}

// Manual sync function that user can trigger after signing in
export async function syncClerkSession(options = {}) {
  const { notify = true } = options;
  try {
    const config = await getRuntimeConfig();
    console.log('Syncing Clerk session from cookies...');
    const allCookies = await collectClerkCookies();
    
    console.log('All unique Clerk cookies:', allCookies.map(c => `${c.name} (${c.domain})`));
    
    // Look for the session cookie
    const sessionCookie = await pickCookie(allCookies, '__session');
    const clientUat = await pickCookie(allCookies, '__client_uat');
    const clerkDbJwt = await pickCookie(allCookies, '__clerk_db_jwt');
    
    console.log('Session cookie:', sessionCookie?.value?.substring(0, 30));
    console.log('Client UAT:', clientUat?.value);
    console.log('Clerk DB JWT:', clerkDbJwt?.value?.substring(0, 30));
    
    // If we have a __session cookie, decode it to get session ID, then fetch Convex token
    if (sessionCookie) {
      console.log('Found __session cookie, decoding...');
      
      // Decode the JWT payload to get user info and session ID
      const parts = sessionCookie.value.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        console.log('JWT payload:', payload);
        
        // Get a proper Convex token using the session ID
        const convexToken = await getConvexToken(payload.sid);

        if (convexToken) {
          const userData = {
            id: payload.sub,
            email: payload.email || '',
            fullName: payload.name || '',
            firstName: payload.first_name || payload.name?.split(' ')[0] || '',
            lastName: payload.last_name || '',
            imageUrl: payload.image_url || '',
            token: convexToken,
            tokenExpiry: Date.now() + (55 * 1000),
            sessionId: payload.sid
          };
          
          await storeAuthData(userData);
          if (notify) {
            notifyAuthChange(currentUser);
          }
          console.log('✅ Session synced:', userData.email, 'has Convex token:', !!convexToken);
          return userData;
        }

        console.warn('Found Clerk session cookie, but could not mint a Convex token from it. Falling back to Clerk client API.');
      }
    }
    
    // If we have a __clerk_db_jwt, try fetching the client endpoint
    if (clerkDbJwt || clientUat) {
      console.log('Trying Clerk client API...');
      
      const dbJwtParam = clerkDbJwt ? `&__clerk_db_jwt=${encodeURIComponent(clerkDbJwt.value)}` : '';
      const clientResponse = await fetch(`${config.clerkApiDomain}/v1/client?_clerk_js_version=5.0.0${dbJwtParam}`);
      
      console.log('Client API status:', clientResponse.status);
      
      if (clientResponse.ok) {
        const clientData = await clientResponse.json();
        console.log('Client API response keys:', Object.keys(clientData));
        const sessions = extractSessionsFromClientData(clientData);
        console.log('Client API session count:', sessions.length);
        
        if (sessions.length > 0) {
          const lastActiveSessionId =
            clientData?.response?.last_active_session_id ||
            clientData?.client?.last_active_session_id;
          const session = sessions.find(candidate => candidate?.id === lastActiveSessionId) || sessions[0];
          const user = session.user;
          
          // Get Convex JWT token
          const tokenResponse = await fetch(
            `${config.clerkApiDomain}/v1/client/sessions/${session.id}/tokens/convex?_clerk_js_version=5.0.0${dbJwtParam}`,
            {
              method: 'POST',
            }
          );
          
          let token = session.last_active_token?.jwt;
          
          if (tokenResponse.ok) {
            const tokenData = await tokenResponse.json();
            token = tokenData.jwt || token;
          }
          
          if (!token) {
            throw new Error('Could not get JWT token from session');
          }
          
          const userData = {
            id: user.id,
            email: user.primary_email_address_id ? 
              user.email_addresses.find(e => e.id === user.primary_email_address_id)?.email_address :
              user.email_addresses?.[0]?.email_address,
            fullName: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
            firstName: user.first_name,
            lastName: user.last_name,
            imageUrl: user.image_url,
            token: token,
            tokenExpiry: Date.now() + (50 * 60 * 1000),
            sessionId: session.id
          };
          
          await storeAuthData(userData);
          if (notify) {
            notifyAuthChange(currentUser);
          }
          console.log('✅ Session synced from API:', userData.email);
          return userData;
        }

        console.warn('Clerk client API returned no active sessions. User may be signed out in the configured Clerk instance.');
      }
    }
    
    throw new Error(
      `No Clerk session found. Found cookies: ${allCookies.map(c => c.name).join(', ') || 'none'}. ` +
      `Please sign in with Google first, then try Sync Session again.`
    );
    
  } catch (error) {
    console.error('Error syncing session:', error);
    throw error;
  }
}

export async function signUp() {
  return await signIn();
}

export async function signOut() {
  try {
    const config = await getRuntimeConfig();
    // Clear local storage
    currentUser = null;
    const authStorageKey = await getAuthStorageKey();
    await chrome.storage.local.remove([authStorageKey, LEGACY_AUTH_STORAGE_KEY, '__clerk_db_jwt']);
    
    // Sign out from Clerk
    await fetch(`${config.clerkDomain}/v1/client/sign_outs`, {
      method: 'POST',
      credentials: 'include'
    });
    
    notifyAuthChange(null);
    console.log('Signed out successfully');
  } catch (error) {
    console.error('Error signing out:', error);
    throw error;
  }
}

// Auth state change listener
export function onAuthChange(callback) {
  authListeners.push(callback);
  return () => {
    authListeners = authListeners.filter(cb => cb !== callback);
  };
}

function notifyAuthChange(user) {
  authListeners.forEach(callback => {
    try {
      callback(user);
    } catch (error) {
      console.error('Error in auth change listener:', error);
    }
  });
}
