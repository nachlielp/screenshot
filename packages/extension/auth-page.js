import { storeAuthData } from './utils/auth.js';
import { getRuntimeConfig } from './utils/runtime-config.js';

async function loadClerkScript(clerkDomain) {
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `${clerkDomain}/.well-known/clerk.js`;
        script.crossOrigin = 'anonymous';
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Failed to load Clerk script from ${clerkDomain}`));
        document.head.appendChild(script);
    });
}

async function initClerk() {
    try {
        const config = await getRuntimeConfig();
        await loadClerkScript(config.clerkDomain);

        // Wait for Clerk to load
        while (!window.Clerk) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Initialize Clerk
        await window.Clerk.load({
            publishableKey: config.clerkPublishableKey
        });
        
        const signInDiv = document.getElementById('clerk-container');
        signInDiv.innerHTML = '';

        // Check if already signed in
        if (window.Clerk.user && window.Clerk.session) {
            handleSignInSuccess(window.Clerk.user, window.Clerk.session);
            return;
        }

        // Build Google sign-in button
        const btn = document.createElement('button');
        btn.id = 'google-signin-btn';
        btn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 48 48">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            Sign in with Google
        `;
        Object.assign(btn.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            width: '100%',
            padding: '14px 24px',
            fontSize: '16px',
            fontWeight: '500',
            color: '#1f1f1f',
            background: '#fff',
            border: '1px solid #dadce0',
            borderRadius: '8px',
            cursor: 'pointer',
            marginTop: '40px',
            fontFamily: 'system-ui, -apple-system, sans-serif'
        });
        btn.onmouseenter = () => { btn.style.background = '#f7f8f8'; };
        btn.onmouseleave = () => { btn.style.background = '#fff'; };
        btn.onclick = async () => {
            btn.disabled = true;
            btn.style.opacity = '0.7';
            btn.querySelector('span')?.remove();
            try {
                await window.Clerk.client.signIn.authenticateWithRedirect({
                    strategy: 'oauth_google',
                    redirectUrl: chrome.runtime.getURL('auth-callback.html'),
                    redirectUrlComplete: window.location.href
                });
            } catch (err) {
                console.error('Google sign-in error:', err);
                btn.disabled = false;
                btn.style.opacity = '1';
            }
        };
        signInDiv.appendChild(btn);

        // Listen for sign-in success (e.g. returning from redirect)
        window.Clerk.addListener((payload) => {
            if (payload.user && payload.session) {
                handleSignInSuccess(payload.user, payload.session);
            }
        });
        
    } catch (error) {
        console.error('Error initializing Clerk:', error);
        document.getElementById('clerk-container').innerHTML = `
            <div style="text-align: center; padding: 40px; color: #ef4444;">
                <h3>Error loading authentication</h3>
                <p>${error.message}</p>
                <button onclick="location.reload()" style="
                    background: #3b82f6;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 6px;
                    color: white;
                    cursor: pointer;
                    margin-top: 20px;
                ">Try Again</button>
            </div>
        `;
    }
}

async function handleSignInSuccess(user, session) {
    try {
        // Get the Convex JWT token
        const token = await session.getToken({ template: 'convex' });
        
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
        
        // Store in extension storage
        await storeAuthData(userData);
        
        // Show success message
        document.getElementById('clerk-container').innerHTML = `
            <div class="success">
                <h2>✅ Success!</h2>
                <p>You're signed in as <strong>${userData.email}</strong></p>
                <p style="margin-top: 30px;">You can close this tab now.</p>
            </div>
        `;
        
        // Close automatically after 2 seconds
        setTimeout(() => {
            window.close();
        }, 2000);
        
    } catch (error) {
        console.error('Error storing auth:', error);
    }
}

// Initialize when page loads
initClerk();
