const DEFAULT_DEV_SITE_URL = "http://localhost:5173";
const DEFAULT_PROD_SITE_URL = "https://snap.nachli.com";

const ENVIRONMENTS = {
  development: {
    name: "development",
    convexUrl: "https://fleet-hound-777.convex.cloud",
    clerkPublishableKey: "pk_test_cmVsYXhpbmctZm94LTgwLmNsZXJrLmFjY291bnRzLmRldiQ",
    clerkApiDomain: "https://relaxing-fox-80.clerk.accounts.dev",
    cookieDomains: [
      "relaxing-fox-80.accounts.dev",
      ".relaxing-fox-80.accounts.dev",
      "relaxing-fox-80.clerk.accounts.dev",
      ".relaxing-fox-80.clerk.accounts.dev",
    ],
    exactCookieDomains: [
      "relaxing-fox-80.accounts.dev",
      "relaxing-fox-80.clerk.accounts.dev",
    ],
    siteUrl: DEFAULT_DEV_SITE_URL,
  },
  production: {
    name: "production",
    convexUrl: "https://fiery-yak-273.convex.cloud",
    clerkPublishableKey: "pk_live_Y2xlcmsuc25hcC5uYWNobGkuY29tJA",
    clerkApiDomain: "https://clerk.snap.nachli.com",
    cookieDomains: [
      "snap.nachli.com",
      ".snap.nachli.com",
      "clerk.snap.nachli.com",
      ".clerk.snap.nachli.com",
    ],
    exactCookieDomains: [
      "snap.nachli.com",
      "clerk.snap.nachli.com",
    ],
    siteUrl: DEFAULT_PROD_SITE_URL,
  },
};

const PROD_EXTENSION_ID = "xxx";
const DEV_EXTENSION_ID = "kfgenggconhplhkacoidmmbkcbbbbcng";

function decodePublishableKeyFrontendApi(publishableKey) {
  const encodedFrontendApi = publishableKey?.split("_")[2];
  if (!encodedFrontendApi) {
    throw new Error("Invalid Clerk publishable key");
  }

  return atob(encodedFrontendApi).replace(/\$$/, "");
}

function normalizeDomain(value) {
  return value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function getActiveEnvironment() {
  const extensionId = chrome.runtime.id;

  if (extensionId === PROD_EXTENSION_ID) {
    return "production";
  }

  if (extensionId === DEV_EXTENSION_ID) {
    return "development";
  }

  return "development";
}

export async function getRuntimeConfig() {
  const environment = getActiveEnvironment();
  const baseConfig = ENVIRONMENTS[environment];

  const frontendApi = decodePublishableKeyFrontendApi(baseConfig.clerkPublishableKey);
  const clerkDomain = `https://${frontendApi}`;
  const clerkApiDomain = baseConfig.clerkApiDomain || clerkDomain;

  const domainCandidates = new Set([
    normalizeDomain(clerkDomain),
    normalizeDomain(clerkApiDomain),
    ...baseConfig.cookieDomains,
  ]);

  const cookieDomains = [...domainCandidates].flatMap((domain) => {
    const normalized = normalizeDomain(domain);
    return normalized.startsWith(".") ? [normalized] : [normalized, `.${normalized}`];
  });

  const exactCookieDomains = [
    normalizeDomain(clerkDomain),
    normalizeDomain(clerkApiDomain),
    ...baseConfig.exactCookieDomains.map(normalizeDomain),
  ];

  return {
    ...baseConfig,
    environment,
    clerkDomain,
    clerkApiDomain,
    clerkCookieUrls: [clerkDomain, clerkApiDomain],
    clerkCookieDomains: [...new Set(cookieDomains)],
    exactCookieDomains: [...new Set(exactCookieDomains)],
  };
}
