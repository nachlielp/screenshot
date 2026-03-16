// This script extracts Clerk session data from the page's localStorage
(function() {
    try {
        console.log('[Clerk Extractor] Checking for Clerk session data...');
        
        // Method 1: Check localStorage
        const allLocalStorage = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            allLocalStorage[key] = localStorage.getItem(key);
        }
        console.log('[Clerk Extractor] All localStorage keys:', Object.keys(allLocalStorage));
        
        // Method 2: Check if Clerk is loaded on the page
        if (window.Clerk) {
            console.log('[Clerk Extractor] Found window.Clerk');
            
            const user = window.Clerk.user;
            const session = window.Clerk.session;
            
            if (user && session) {
                console.log('[Clerk Extractor] Found active Clerk session on window');
                
                // Try to get token
                session.getToken({ template: 'convex' }).then(token => {
                    const userData = {
                        id: user.id,
                        email: user.primaryEmailAddress?.emailAddress || user.emailAddresses?.[0]?.emailAddress,
                        fullName: user.fullName || `${user.firstName || ''} ${user.lastName || ''}`.trim(),
                        firstName: user.firstName,
                        lastName: user.lastName,
                        imageUrl: user.imageUrl,
                        token: token,
                        tokenExpiry: Date.now() + (50 * 60 * 1000),
                        sessionId: session.id
                    };
                    
                    console.log('[Clerk Extractor] Sending session data to extension');
                    chrome.runtime.sendMessage({
                        type: 'clerk-session-data',
                        data: userData
                    });
                }).catch(err => {
                    console.error('[Clerk Extractor] Error getting token:', err);
                    chrome.runtime.sendMessage({
                        type: 'clerk-session-error',
                        error: 'Failed to get token: ' + err.message
                    });
                });
                
                return;
            }
        }
        
        // Method 3: Parse localStorage data
        let clientData = null;
        
        for (const key in allLocalStorage) {
            const value = allLocalStorage[key];
            if (value && (key.includes('clerk') || key.includes('client'))) {
                try {
                    const parsed = JSON.parse(value);
                    console.log(`[Clerk Extractor] Parsed ${key}:`, parsed);
                    
                    if (parsed.sessions || parsed.client?.sessions) {
                        clientData = parsed;
                        console.log('[Clerk Extractor] Found client data in key:', key);
                        break;
                    }
                } catch (e) {
                    // Not JSON or not the right format
                }
            }
        }
        
        if (clientData) {
            const client = clientData.client || clientData;
            const sessions = client.sessions || [];
            
            if (sessions.length > 0) {
                const session = sessions[0];
                const user = session.user;
                const token = session.last_active_token?.jwt;
                
                if (user && token) {
                    const userData = {
                        id: user.id,
                        email: user.email_addresses?.[0]?.email_address || user.primary_email_address?.email_address,
                        fullName: user.full_name || `${user.first_name || ''} ${user.last_name || ''}`.trim(),
                        firstName: user.first_name,
                        lastName: user.last_name,
                        imageUrl: user.image_url || user.profile_image_url,
                        token: token,
                        tokenExpiry: Date.now() + (50 * 60 * 1000),
                        sessionId: session.id
                    };
                    
                    console.log('[Clerk Extractor] Session data extracted from localStorage');
                    
                    chrome.runtime.sendMessage({
                        type: 'clerk-session-data',
                        data: userData
                    });
                    
                    return;
                }
            }
        }
        
        console.log('[Clerk Extractor] No valid session data found. Please make sure you are signed in.');
        chrome.runtime.sendMessage({
            type: 'clerk-session-error',
            error: 'No active Clerk session found. Please sign in and try again.'
        });
        
    } catch (error) {
        console.error('[Clerk Extractor] Error:', error);
        chrome.runtime.sendMessage({
            type: 'clerk-session-error',
            error: error.message
        });
    }
})();
