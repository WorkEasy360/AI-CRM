import { CSRF_HEADER_NAME, getCsrfToken } from "@/lib/csrf";
import { ApiError, parseProblem } from "@/lib/api/problem";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface RawResponse {
  status: number;
  ok: boolean;
  json: unknown;
  headers: Headers;
}

const SAFE_METHODS: ReadonlySet<HttpMethod> = new Set(["GET"]);

/** A side-effect-free GET that makes Django set the CSRF cookie (allauth's headless config). */
export const CSRF_BOOTSTRAP_PATH = "/_allauth/browser/v1/config";

let csrfBootstrap: Promise<void> | null = null;

/**
 * The CSRF token for an unsafe request. Django sets the cookie in the response to a GET, but a page
 * can POST before any GET has come back: the verify-email page posts on mount, so a link opened in a
 * browser that had never visited Keel was rejected with 403. When the cookie is missing, one GET to
 * CSRF_BOOTSTRAP_PATH sets it first. That GET happens at most once per page load and is shared by
 * concurrent callers; if it does not produce a cookie (blocked cookies, network error) the request
 * still goes out without a token and Django rejects it exactly as before. There is no retry loop.
 */
async function csrfTokenForUnsafeRequest(): Promise<string | null> {
  const existing = getCsrfToken();
  if (existing || typeof document === "undefined") return existing;
  csrfBootstrap ??= fetch(CSRF_BOOTSTRAP_PATH, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "include",
    cache: "no-store",
  }).then(
    () => undefined,
    () => undefined,
  );
  await csrfBootstrap;
  return getCsrfToken();
}

/**
 * Handler invoked when the API says the session is gone (401/403
 * not_authenticated). Registered by the authenticated app shell so that a
 * mid-session expiry bounces the user to /login; unregistered elsewhere so
 * the login page itself can probe the session without redirecting.
 */
let unauthenticatedHandler: ((error: ApiError) => void) | null = null;

export function setUnauthenticatedHandler(handler: ((error: ApiError) => void) | null): void {
  unauthenticatedHandler = handler;
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!path.startsWith("/")) throw new Error(`API paths must be same-origin and start with "/": ${path}`);
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!text) return undefined;
  if (contentType.includes("json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Low-level same-origin request. Always sends cookies, always sends the CSRF
 * header on unsafe methods, never throws on non-2xx (callers such as the
 * allauth client interpret 401 bodies themselves).
 */
export async function request(path: string, options: RequestOptions = {}): Promise<RawResponse> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  if (!SAFE_METHODS.has(method)) {
    const token = await csrfTokenForUnsafeRequest();
    if (token) headers[CSRF_HEADER_NAME] = token;
  }
  const response = await fetch(buildUrl(path, options.query), {
    method,
    headers,
    body,
    credentials: "include",
    signal: options.signal,
    cache: "no-store",
  });
  const json = await readJson(response);
  return { status: response.status, ok: response.ok, json, headers: response.headers };
}

/**
 * Typed request that throws ApiError (with parsed problem details) on any
 * non-2xx response. Use this for the app API under /api/v1/.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await request(path, options);
  if (res.ok) return res.json as T;
  const error = new ApiError(parseProblem(res.status, res.json));
  if (error.isNotAuthenticated && unauthenticatedHandler) unauthenticatedHandler(error);
  throw error;
}

/**
 * Multipart upload (CSV imports). The browser sets the multipart boundary itself, so no Content-Type
 * header is written here; the CSRF header is still required.
 */
export async function requestForm<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = await csrfTokenForUnsafeRequest();
  if (token) headers[CSRF_HEADER_NAME] = token;
  const response = await fetch(buildUrl(path), {
    method: "POST",
    headers,
    body: form,
    credentials: "include",
    signal,
    cache: "no-store",
  });
  const json = await readJson(response);
  if (response.ok) return json as T;
  const error = new ApiError(parseProblem(response.status, json));
  if (error.isNotAuthenticated && unauthenticatedHandler) unauthenticatedHandler(error);
  throw error;
}

export const api = {
  get: <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) =>
    apiFetch<T>(path, { method: "GET", query, signal }),
  post: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "POST", body: body ?? {} }),
  patch: <T>(path: string, body: unknown) => apiFetch<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body: unknown) => apiFetch<T>(path, { method: "PUT", body }),
  delete: <T = void>(path: string, body?: unknown) => apiFetch<T>(path, { method: "DELETE", body }),
};

/** Extract the `cursor` query value from a DRF cursor-pagination `next` URL. */
export function cursorFromUrl(next: string | null | undefined): string | null {
  if (!next) return null;
  try {
    const url = new URL(next, "http://placeholder.invalid");
    return url.searchParams.get("cursor");
  } catch {
    return null;
  }
}
