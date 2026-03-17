import { getRuntimeConfig } from "./utils/runtime-config.js";
import { storeAuthData } from "./utils/auth.js";

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");

function log(message) {
  console.log(message);
  logEl.textContent += `${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

(async () => {
  try {
    const config = await getRuntimeConfig();

    log(`Starting authentication sync for ${config.environment}...`);
    statusEl.textContent = "Fetching session from Clerk...";

    const response = await fetch(`${config.clerkDomain}/v1/client`, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    });

    log(`API Response status: ${response.status}`);

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    log("API response received");

    const client = data.response || data.client || data;
    const sessions = client.sessions || [];

    log(`Found ${sessions.length} session(s)`);

    if (sessions.length === 0) {
      throw new Error("No active sessions found");
    }

    const session = sessions[0];
    const user = session.user;

    if (!user) {
      throw new Error("No user data in session");
    }

    const token = session.last_active_token?.jwt;
    if (!token) {
      throw new Error("No JWT token found");
    }

    const userData = {
      id: user.id,
      email:
        user.email_addresses?.[0]?.email_address ||
        user.primary_email_address?.email_address ||
        "unknown@email.com",
      fullName:
        user.full_name ||
        `${user.first_name || ""} ${user.last_name || ""}`.trim() ||
        "User",
      firstName: user.first_name || "",
      lastName: user.last_name || "",
      imageUrl: user.image_url || user.profile_image_url || "",
      token,
      tokenExpiry: Date.now() + 50 * 60 * 1000,
      sessionId: session.id,
    };

    await storeAuthData(userData);
    await chrome.storage.local.set({ auth_success: true });

    statusEl.className = "status success";
    statusEl.textContent = `Successfully authenticated as ${userData.email}.\n\nClosing in 2 seconds...`;

    setTimeout(() => {
      window.close();
    }, 2000);
  } catch (error) {
    console.error("Sync error:", error);
    log(`Error: ${error.message}`);

    statusEl.className = "status error";
    statusEl.textContent = `Error: ${error.message}\n\nClosing in 5 seconds...`;

    setTimeout(() => {
      window.close();
    }, 5000);
  }
})();
