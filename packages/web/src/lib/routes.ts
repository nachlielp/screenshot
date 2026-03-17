export function buildAppUrl(hashPath: string) {
  const baseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);
  const normalizedPath = hashPath.startsWith("/") ? hashPath : `/${hashPath}`;
  baseUrl.hash = normalizedPath;
  return baseUrl.toString();
}

export function migrateLegacyPathToHashRoute() {
  const basePath = import.meta.env.BASE_URL === "/"
    ? ""
    : import.meta.env.BASE_URL.replace(/\/$/, "");
  const pathname = window.location.pathname;
  const relativePath = basePath && pathname.startsWith(basePath)
    ? pathname.slice(basePath.length) || "/"
    : pathname;

  if (window.location.hash) {
    return;
  }

  if (
    relativePath === "/library" ||
    relativePath === "/privacy" ||
    relativePath.startsWith("/snapshot/")
  ) {
    const nextUrl = `${basePath || ""}/#${relativePath}${window.location.search}`;
    window.history.replaceState(null, "", nextUrl);
  }
}
