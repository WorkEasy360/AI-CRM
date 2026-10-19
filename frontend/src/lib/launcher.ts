const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Workeasy360 app launcher opens `<launch_url>?organization=<uuid>`. Send that straight into
 * "Sign in with Workeasy360" for the chosen organization -- even when a session exists, so the user lands
 * in the organization they picked rather than the last one they used. The id is only forwarded: the
 * server takes the organization from the verified ID token, never from this parameter.
 */
export function launcherRedirect(url: URL): URL | null {
  const organization = url.searchParams.get("organization");
  if (!organization || !UUID_RE.test(organization)) return null;
  const start = new URL("/api/auth/workeasy360/start", url);
  start.searchParams.set("organization", organization.toLowerCase());
  if (url.pathname !== "/") start.searchParams.set("next", url.pathname);
  return start;
}
