export type NavigationArea = "workspace" | "system";

export function normalizeNavPath(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0];
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape should not prevent navigation from rendering.
    decoded = pathname;
  }
  return decoded.replace(/\/+$/, "") || "/";
}

function matchesNavPath(path: string, url: string): boolean {
  return path === url || (url !== "/" && path.startsWith(`${url}/`));
}

export function getNavigationArea(path: string): NavigationArea {
  return matchesNavPath(normalizeNavPath(path), "/system") ? "system" : "workspace";
}

export function getActiveNavUrl(path: string, urls: readonly string[]): string | undefined {
  const pathname = normalizeNavPath(path);
  let activeUrl: string | undefined;
  let longestMatch = -1;
  for (const url of urls) {
    const candidate = normalizeNavPath(url);
    if (candidate.length > longestMatch && matchesNavPath(pathname, candidate)) {
      activeUrl = url;
      longestMatch = candidate.length;
    }
  }
  return activeUrl;
}

export function isWorkspaceUrl(url: string): boolean {
  if (!url.startsWith("/") || url.startsWith("//")) return false;
  const pathname = normalizeNavPath(url);
  if (
    pathname.startsWith("//") ||
    pathname.includes("\\") ||
    [...pathname].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    return false;
  }
  // Browser-normalized dot segments could otherwise return the user to system settings.
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return ["/chat", "/dashboard", "/function"].some((base) => matchesNavPath(pathname, base));
}
