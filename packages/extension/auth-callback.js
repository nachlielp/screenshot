// This script runs when Clerk redirects back to the extension after authentication
(async () => {
    try {
        console.log('Auth callback received');
        console.log('Full URL:', window.location.href);
        
        // Extract any session token from URL hash or query params
        const urlParams = new URLSearchParams(window.location.search);
        const hash = window.location.hash;
        
        console.log('URL params:', Object.fromEntries(urlParams));
        console.log('Hash:', hash);
        
        // Wait for Clerk to set cookies
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Method 1: Try to get cookies from Clerk domain
        let sessionToken = null;
        try {
            const cookies = await chrome.cookies.getAll({
                url: 'https://relaxing-fox-80.accounts.dev'
            });
            
            console.log('Found cookies:', cookies.map(c => ({ name: c.name, value: c.value.substring(0, 20) + '...' })));
            
            // Look for session token in cookies
            const sessionCookie = cookies.find(c => 
                c.name === '__session' || 
                c.name === '__clerk_db_jwt' ||
                c.name.startsWith('__clerk')
            );
            
            if (sessionCookie) {
                console.log('Found session cookie:', sessionCookie.name);
                sessionToken = sessionCookie.value;
            }
        } catch (cookieError) {
            console.error('Error reading cookies:', cookieError);
        }
        
        // Method 2: Try to fetch from Clerk API with credentials
        try {
            console.log('Attempting to fetch session from Clerk API...');
            const response = await fetch('https://relaxing-fox-80.accounts.dev/v1/client?_clerk_js_version=5', {
                method: 'GET',
                credentials: 'include',
                headers: {
                    'Accept': 'application/json'
                }
            });
            
            console.log('Clerk API response status:', response.status);
            
            if (response.ok) {
                const data = await response.json();
                console.log('Clerk API response:', data);
                
                const client = data.response || data.client || data;
                const session = client.sessions?.[0];
                const user = session?.user;
                
                if (user && session) {
                    console.log('Successfully got user from API:', {
                        id: user.id,
                        email: user.email_addresses?.[0]?.email_address,
                        name: user.first_name
                    });
                    
                    const userData = {
                        id: user.id,
                        email: user.email_addresses?.[0]?.email_address || user.primary_email_address?.email_address || 'no-email',
                        fullName: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'User',
                        firstName: user.first_name || '',
                        lastName: user.last_name || '',
                        imageUrl: user.image_url || '',
                        token: session.last_active_token?.jwt || sessionToken,
                        tokenExpiry: Date.now() + (50 * 60 * 1000),
                        sessionId: session.id,
                        rawSession: session
                    };
                    
                    console.log('Storing user data:', userData);
                    
                    await chrome.storage.local.set({ 
                        'clerk_auth': userData,
                        'auth_success': true
                    });
                    
                    console.log('✅ Auth data stored successfully!');
                    
                    setTimeout(() => {
                        window.close();
                    }, 500);
                    return;
                }
            } else {
                console.error('Clerk API error:', response.status, await response.text());
            }
        } catch (apiError) {
            console.error('Error calling Clerk API:', apiError);
        }
        
        // Method 3: Check if we at least have a session cookie and store minimal data
        if (sessionToken) {
            console.log('Storing minimal auth data from cookie');
            await chrome.storage.local.set({ 
                'clerk_auth': {
                    token: sessionToken,
                    tokenExpiry: Date.now() + (50 * 60 * 1000),
                    email: 'authenticated@user.com',
                    fullName: 'Authenticated User',
                    id: 'clerk_user'
                },
                'auth_success': true
            });
            
            console.log('✅ Minimal auth stored');
            setTimeout(() => window.close(), 500);
            return;
        }
        
        console.warn('⚠️ Could not capture session data');
        await chrome.storage.local.set({ 'auth_attempted': true });
        
        setTimeout(() => {
            window.close();
        }, 2000);
        
    } catch (error) {
        console.error('❌ Error in auth callback:', error);
        setTimeout(() => {
            window.close();
        }, 2000);
    }
})();
