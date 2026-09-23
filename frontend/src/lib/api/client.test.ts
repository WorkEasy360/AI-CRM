import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A completely fresh browser: no Keel cookies. Every test loads a fresh copy of the client module, so
 * the once-per-page-load CSRF bootstrap starts unused, exactly as on a first visit.
 */
type Client = typeof import("@/lib/api/client");
type Allauth = typeof import("@/lib/api/allauth");

const BOOTSTRAP = "/_allauth/browser/v1/config";
const TOKEN = "fresh-browser-token";

function clearCookies() {
  for (const name of ["keel_csrftoken", "__Host-keel_csrftoken"]) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

function json(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Fake server: the bootstrap GET sets the CSRF cookie the way Django's response would. */
function server({ setsCookie = true, bootstrapFails = false } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === BOOTSTRAP) {
      if (bootstrapFails) throw new TypeError("network error");
      if (setsCookie) document.cookie = `keel_csrftoken=${TOKEN}; path=/`;
      return json(200, { status: 200, data: {} });
    }
    const method = init?.method ?? "GET";
    if (method !== "GET" && !(init?.headers as Record<string, string> | undefined)?.["X-CSRFToken"]) {
      return json(403, { detail: "CSRF Failed: CSRF cookie not set." });
    }
    return json(200, { status: 200, data: {}, meta: { is_authenticated: true } });
  });
}

let fetchMock: ReturnType<typeof server>;
const calls = () => fetchMock.mock.calls.map(([input, init]) => ({
  url: String(input),
  method: init?.method ?? "GET",
  token: (init?.headers as Record<string, string> | undefined)?.["X-CSRFToken"],
}));

async function load(): Promise<{ client: Client; allauth: Allauth }> {
  vi.resetModules();
  return { client: await import("@/lib/api/client"), allauth: await import("@/lib/api/allauth") };
}

describe("CSRF bootstrap on a fresh browser", () => {
  beforeEach(() => clearCookies());
  afterEach(() => {
    vi.unstubAllGlobals();
    clearCookies();
  });

  it("fetches the CSRF cookie once before the first POST, then sends the token", async () => {
    fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await load();

    const res = await client.request("/api/v1/contacts/", { method: "POST", body: { first_name: "Ada" } });

    expect(res.status).toBe(200);
    expect(calls()).toEqual([
      { url: BOOTSTRAP, method: "GET", token: undefined },
      { url: "/api/v1/contacts/", method: "POST", token: TOKEN },
    ]);
  });

  it("signup and login from a fresh browser carry the token, with a single bootstrap", async () => {
    fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    const { allauth } = await load();

    await allauth.signup({ email: "ada@example.com", password: "correct-horse-battery" });
    await allauth.login({ email: "ada@example.com", password: "correct-horse-battery" });

    expect(calls()).toEqual([
      { url: BOOTSTRAP, method: "GET", token: undefined },
      { url: "/_allauth/browser/v1/auth/signup", method: "POST", token: TOKEN },
      { url: "/_allauth/browser/v1/auth/login", method: "POST", token: TOKEN },
    ]);
  });

  it("verifies an email opened in a fresh browser (the page posts on mount)", async () => {
    fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    const { allauth } = await load();

    await allauth.verifyEmail("MQ:1abc:sig");

    expect(calls().map((c) => [c.url, c.token])).toEqual([
      [BOOTSTRAP, undefined],
      ["/_allauth/browser/v1/auth/email/verify", TOKEN],
    ]);
  });

  it("shares one bootstrap GET between concurrent POST, PATCH and DELETE requests", async () => {
    fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await load();

    await Promise.all([
      client.request("/api/v1/notes/", { method: "POST", body: {} }),
      client.request("/api/v1/contacts/1/", { method: "PATCH", body: {} }),
      client.request("/api/v1/contacts/2/", { method: "DELETE" }),
    ]);

    expect(calls().filter((c) => c.url === BOOTSTRAP)).toHaveLength(1);
    expect(calls().filter((c) => c.url !== BOOTSTRAP).every((c) => c.token === TOKEN)).toBe(true);
  });

  it("also bootstraps multipart uploads (CSV imports)", async () => {
    fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await load();

    await client.requestForm("/api/v1/imports/", new FormData());

    expect(calls()).toEqual([
      { url: BOOTSTRAP, method: "GET", token: undefined },
      { url: "/api/v1/imports/", method: "POST", token: TOKEN },
    ]);
  });

  it("never bootstraps when the cookie already exists (returning visitor)", async () => {
    document.cookie = `keel_csrftoken=${TOKEN}; path=/`;
    fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await load();

    await client.request("/api/v1/contacts/", { method: "POST", body: {} });

    expect(calls()).toEqual([{ url: "/api/v1/contacts/", method: "POST", token: TOKEN }]);
  });

  it("never bootstraps for GET requests", async () => {
    fetchMock = server();
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await load();

    await client.request("/api/v1/session/");

    expect(calls()).toEqual([{ url: "/api/v1/session/", method: "GET", token: undefined }]);
  });

  it("does not loop when no cookie can be obtained: one GET, then Django's normal CSRF rejection", async () => {
    fetchMock = server({ setsCookie: false });
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await load();

    const first = await client.request("/api/v1/contacts/", { method: "POST", body: {} });
    const second = await client.request("/api/v1/contacts/", { method: "POST", body: {} });

    expect(first.status).toBe(403);
    expect(second.status).toBe(403);
    expect(calls().filter((c) => c.url === BOOTSTRAP)).toHaveLength(1);
    expect(calls()).toHaveLength(3);
  });

  it("still sends the request when the bootstrap GET itself fails", async () => {
    fetchMock = server({ bootstrapFails: true });
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await load();

    const res = await client.request("/api/v1/contacts/", { method: "POST", body: {} });

    expect(res.status).toBe(403);
    expect(calls().map((c) => c.url)).toEqual([BOOTSTRAP, "/api/v1/contacts/"]);
  });
});
