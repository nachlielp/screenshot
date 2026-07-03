// Convex serves HTTP actions on the deployment's `.convex.site` domain,
// while the client connects to `.convex.cloud`. Allow an explicit override
// for custom domains, otherwise derive one from the other.
export function getAgentApiBase(): string {
  const explicit = import.meta.env.VITE_CONVEX_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  return import.meta.env.VITE_CONVEX_URL.replace(
    ".convex.cloud",
    ".convex.site"
  ).replace(/\/$/, "");
}

export function buildSnapshotAgentUrl(shareToken: string): string {
  return `${getAgentApiBase()}/api/snapshot/${shareToken}`;
}
