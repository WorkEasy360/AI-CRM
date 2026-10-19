"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { safeNext } from "@/lib/safe-next";

/**
 * Which ways in the server offers (GET /api/v1/auth/methods/). When Workeasy360 is the only sign-in,
 * `password` is false and the server refuses password sign-in, sign-up and reset whatever the UI shows;
 * hiding those forms is only so nobody is offered a door that will not open.
 */
export interface AuthMethods {
  password: boolean;
  workeasy360: boolean;
  /** "Sign out of WorkEasy CRM and Workeasy360" is offered (RP-initiated logout is configured). */
  workeasy360_sign_out?: boolean;
}

export const getAuthMethods = (signal?: AbortSignal) => api.get<AuthMethods>("/api/v1/auth/methods/", undefined, signal);

export const authMethodsKey = ["auth", "methods"] as const;

export function useAuthMethods(): UseQueryResult<AuthMethods, Error> {
  return useQuery({ queryKey: authMethodsKey, queryFn: ({ signal }) => getAuthMethods(signal), staleTime: 10 * 60_000 });
}

/**
 * Where the browser goes to sign in with Workeasy360. A top-level navigation, never a fetch.
 * `reauth` ("Confirm it's you") asks Workeasy360 for a fresh sign-in; the server then checks the
 * ID token says the password was entered after the request (auth_time), not just that a Workeasy360
 * session was still open.
 */
export function workeasy360StartUrl(next?: string | null, options: { reauth?: boolean } = {}): string {
  const target = safeNext(next, "");
  const params = new URLSearchParams();
  if (target) params.set("next", target);
  if (options.reauth) params.set("reauth", "1");
  const query = params.toString();
  return query ? `/api/auth/workeasy360/start?${query}` : "/api/auth/workeasy360/start";
}

/** "Sign out of WorkEasy CRM and Workeasy360": after Keel's own sign-out, the server sends the browser on
 * to Workeasy360, which asks before signing anyone out and then returns here. */
export const WORKEASY360_SIGN_OUT_URL = "/api/auth/workeasy360/logout";

/** Messages for the fixed `sso_error` vocabulary the server's callback redirects with. */
const SSO_ERROR_MESSAGES: Record<string, string> = {
  cancelled: "Sign-in was cancelled at Workeasy360.",
  expired: "That sign-in took too long or was already used. Please try again.",
  unavailable: "Workeasy360 sign-in is not available right now. Please try again in a few minutes.",
  refused: "Workeasy360 could not complete the sign-in. Please try again.",
  rate_limited: "Too many sign-in attempts. Wait a minute and try again.",
  not_entitled: "Your organization does not have WorkEasy CRM yet. Start a trial or buy it in Workeasy360.",
  no_seat: "You have not been given an WorkEasy CRM seat. Ask your Workeasy360 administrator to assign you one.",
  provider_membership_inactive: "Your access to this organization in Workeasy360 is suspended. Contact your Workeasy360 administrator.",
  organization_inactive: "This organization is suspended in Workeasy360. Contact your Workeasy360 administrator.",
  access_policy: "Your organization's Workeasy360 access policy did not allow this sign-in.",
  email_missing: "Workeasy360 did not share your email address, which WorkEasy CRM needs to sign you in.",
  email_unverified: "Verify your email address in Workeasy360, then sign in again.",
  account_conflict: "The WorkEasy CRM account for this email address is linked to a different Workeasy360 account. Contact support.",
  account_disabled: "Your WorkEasy CRM account is deactivated. Contact your administrator.",
  membership_inactive: "An WorkEasy CRM administrator has suspended or removed your access to this organization.",
  organization_unavailable: "This organization is not available in WorkEasy CRM. Contact your administrator.",
  seat_limit: "This organization has no free WorkEasy CRM seats. Ask an administrator to free one up.",
  wrong_product: "Workeasy360 signed you in to a different product. Open WorkEasy CRM from the Workeasy360 app launcher.",
  reauthentication_failed: "Workeasy360 did not confirm it's you. Choose Confirm with Workeasy360 again and enter your password.",
  reauthentication_wrong_account:
    "That was a different Workeasy360 account. To confirm it's you, sign in to Workeasy360 with the account you use in WorkEasy CRM.",
};

export function ssoErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return SSO_ERROR_MESSAGES[code] ?? SSO_ERROR_MESSAGES.refused ?? null;
}
