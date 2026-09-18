/**
 * Client for django-allauth headless (browser client).
 * Base: /_allauth/browser/v1/
 *
 * allauth uses HTTP 401 for "not authenticated, here are the flows you can
 * take", which is a *successful* outcome for email verification and password
 * reset (the session may stay signed out). We interpret those bodies here and
 * expose discriminated results; everything else is surfaced as ApiError with
 * normalised problem details.
 */
import { request, type RawResponse } from "@/lib/api/client";
import { ApiError, PROBLEM_TYPES, parseProblem } from "@/lib/api/problem";

const BASE = "/_allauth/browser/v1";

interface AllauthFlow {
  id: string;
  is_pending?: boolean;
  types?: string[];
}

interface AllauthEnvelope {
  status?: number;
  data?: unknown;
  meta?: { is_authenticated?: boolean; [k: string]: unknown };
  errors?: unknown;
}

function envelope(res: RawResponse): AllauthEnvelope {
  return (res.json && typeof res.json === "object" ? res.json : {}) as AllauthEnvelope;
}

function flowsOf(res: RawResponse): AllauthFlow[] {
  const data = envelope(res).data;
  if (data && typeof data === "object" && Array.isArray((data as { flows?: unknown }).flows)) {
    return (data as { flows: AllauthFlow[] }).flows;
  }
  return [];
}

function fail(res: RawResponse): never {
  // allauth signals "re-authenticate first" as 401 + a pending `reauthenticate`
  // flow while the session is still authenticated. Normalise that to the
  // backend's reauth_required problem so the same dialog handles both.
  if (res.status === 401 && envelope(res).meta?.is_authenticated && flowsOf(res).some((f) => f.id === "reauthenticate")) {
    throw new ApiError({
      type: PROBLEM_TYPES.reauthRequired,
      title: "Re-authentication required",
      status: 403,
      detail: "Please confirm your password to continue.",
    });
  }
  throw new ApiError(parseProblem(res.status, res.json));
}

export type AuthOutcome =
  | { kind: "authenticated" }
  | { kind: "mfa_required" }
  | { kind: "verify_email" }
  | { kind: "unknown"; status: number };

function interpretAuth(res: RawResponse): AuthOutcome {
  if (res.ok && envelope(res).meta?.is_authenticated) return { kind: "authenticated" };
  if (res.status === 401) {
    const flows = flowsOf(res);
    if (flows.some((f) => f.id === "mfa_authenticate" && f.is_pending)) return { kind: "mfa_required" };
    if (flows.some((f) => f.id === "verify_email")) return { kind: "verify_email" };
    if (flows.some((f) => f.id === "mfa_authenticate")) return { kind: "mfa_required" };
  }
  if (res.status === 400 || res.status === 403 || res.status === 409 || res.status === 429 || res.status >= 500) fail(res);
  if (res.ok) return { kind: "authenticated" };
  return { kind: "unknown", status: res.status };
}

/* Auth flows */
export async function verifyEmail(key: string): Promise<AuthOutcome> {
  const res = await request(`${BASE}/auth/email/verify`, { method: "POST", body: { key } });
  const outcome = interpretAuth(res);
  if (outcome.kind === "unknown") fail(res);
  return outcome;
}

export async function requestPasswordReset(email: string): Promise<void> {
  const res = await request(`${BASE}/auth/password/request`, { method: "POST", body: { email } });
  if (res.ok) return;
  fail(res);
}

export async function resetPassword(input: { key: string; password: string }): Promise<AuthOutcome> {
  const res = await request(`${BASE}/auth/password/reset`, { method: "POST", body: input });
  if (res.ok || res.status === 401) return interpretAuth(res);
  fail(res);
}

export async function reauthenticate(password: string): Promise<void> {
  const res = await request(`${BASE}/auth/reauthenticate`, { method: "POST", body: { password } });
  if (res.ok) return;
  fail(res);
}

/* Account */
export async function changePassword(input: { current_password: string; new_password: string }): Promise<void> {
  const res = await request(`${BASE}/account/password/change`, { method: "POST", body: input });
  if (res.ok) return;
  fail(res);
}

export interface AuthSession {
  id: number | string;
  user_agent: string;
  ip: string;
  created_at: number | string;
  is_current: boolean;
  last_seen_at?: number | string;
}

export async function listSessions(): Promise<AuthSession[]> {
  const res = await request(`${BASE}/auth/sessions`);
  if (!res.ok) fail(res);
  const data = envelope(res).data;
  return Array.isArray(data) ? (data as AuthSession[]) : [];
}

export async function deleteSessions(ids: Array<number | string>): Promise<AuthSession[]> {
  const res = await request(`${BASE}/auth/sessions`, { method: "DELETE", body: { sessions: ids } });
  if (!res.ok) fail(res);
  const data = envelope(res).data;
  return Array.isArray(data) ? (data as AuthSession[]) : [];
}

/* MFA */
export interface Authenticator {
  type: "totp" | "recovery_codes" | string;
  created_at?: number | string;
  last_used_at?: number | string | null;
  total_code_count?: number;
  unused_code_count?: number;
}

export async function listAuthenticators(): Promise<Authenticator[]> {
  const res = await request(`${BASE}/account/authenticators`);
  if (!res.ok) fail(res);
  const data = envelope(res).data;
  return Array.isArray(data) ? (data as Authenticator[]) : [];
}

export type TotpStatus = { active: true } | { active: false; secret: string | null; totp_url: string | null };

/**
 * GET account/authenticators/totp: 200 when active; 404 with
 * meta.secret / meta.totp_url when not yet set up (some versions omit meta).
 */
export async function getTotp(): Promise<TotpStatus> {
  const res = await request(`${BASE}/account/authenticators/totp`);
  const env = envelope(res);
  if (res.ok) {
    const meta = env.meta as { secret?: string; totp_url?: string } | undefined;
    // Some versions return 200 with the secret in meta when not active.
    if (meta?.secret) return { active: false, secret: meta.secret, totp_url: meta.totp_url ?? null };
    return { active: true };
  }
  if (res.status === 404) {
    const meta = env.meta as { secret?: string; totp_url?: string } | undefined;
    return { active: false, secret: meta?.secret ?? null, totp_url: meta?.totp_url ?? null };
  }
  fail(res);
}

export async function activateTotp(code: string): Promise<void> {
  const res = await request(`${BASE}/account/authenticators/totp`, { method: "POST", body: { code } });
  if (res.ok) return;
  fail(res);
}

export async function deactivateTotp(): Promise<void> {
  const res = await request(`${BASE}/account/authenticators/totp`, { method: "DELETE" });
  if (res.ok) return;
  fail(res);
}

export interface RecoveryCodes {
  unused_codes: string[];
  total_code_count: number;
  unused_code_count: number;
  created_at?: number | string;
}

function recoveryFrom(res: RawResponse): RecoveryCodes {
  const data = (envelope(res).data ?? {}) as Partial<RecoveryCodes>;
  return {
    unused_codes: Array.isArray(data.unused_codes) ? data.unused_codes : [],
    total_code_count: data.total_code_count ?? 0,
    unused_code_count: data.unused_code_count ?? 0,
    created_at: data.created_at,
  };
}

export async function getRecoveryCodes(): Promise<RecoveryCodes | null> {
  const res = await request(`${BASE}/account/authenticators/recovery-codes`);
  if (res.status === 404) return null;
  if (!res.ok) fail(res);
  return recoveryFrom(res);
}

export async function regenerateRecoveryCodes(): Promise<RecoveryCodes> {
  const res = await request(`${BASE}/account/authenticators/recovery-codes`, { method: "POST", body: {} });
  if (!res.ok) fail(res);
  return recoveryFrom(res);
}
