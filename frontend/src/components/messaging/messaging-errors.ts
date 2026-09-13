import { errorMessage, isApiError } from "@/lib/api/problem";

export const EMAIL_SETTINGS_HREF = "/settings/email";
export const WHATSAPP_SETTINGS_HREF = "/settings/whatsapp";

/** True when the API answered with the given problem code (and status, when supplied). */
export function isProblem(error: unknown, code: string, status?: number): boolean {
  return isApiError(error) && error.type === code && (status === undefined || error.status === status);
}

/**
 * Friendly wording for the AI endpoints' failure modes. Quotas and outages are expected events,
 * not bugs, so the user gets a next step rather than a status code.
 */
export function aiErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.type === "ai_quota_user") return "You have reached your hourly AI limit. Try again in a little while, or write the message yourself.";
    if (error.type === "ai_quota_org") return "Your workspace has used today's AI allowance. It resets tomorrow; an administrator can raise the limit.";
    if (error.type === "ai_unavailable" || error.status === 503) return "The AI assistant is temporarily unavailable. You can still write the message yourself.";
    if (error.type === "ai_refused" || error.status === 422) return "The assistant could not produce a draft for this request. Adjust the purpose or instructions and try again.";
    if (error.status === 429) return "Too many AI requests right now. Try again in a little while.";
  }
  return errorMessage(error, "The AI assistant could not produce a draft.");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
