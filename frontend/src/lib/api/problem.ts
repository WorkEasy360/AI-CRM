/**
 * RFC 9457 problem details, as emitted by the Keel backend, plus a
 * normaliser for django-allauth's `{status, errors:[{message, code, param}]}`
 * error envelope so the UI deals with a single shape.
 */
export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: FieldError[];
  request_id?: string;
}

export const PROBLEM_TYPES = {
  reauthRequired: "reauth_required",
  notAuthenticated: "not_authenticated",
  validationError: "validation_error",
  permissionDenied: "permission_denied",
  unknown: "about:blank",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normaliseFieldErrors(value: unknown): FieldError[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: FieldError[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const message = str(item.message) ?? str(item.detail) ?? "";
    if (!message) continue;
    out.push({
      // Backend problem details use `field`; allauth uses `param`.
      field: str(item.field) ?? str(item.param) ?? "non_field_errors",
      code: str(item.code) ?? "invalid",
      message,
    });
  }
  return out.length ? out : undefined;
}

/** Strip the URI prefix some emitters put in front of the problem `type`. */
function normaliseType(rawType: string | undefined, status: number): string {
  if (rawType) {
    const last = rawType.split("/").filter(Boolean).pop();
    if (last && rawType !== "about:blank") return last;
    if (rawType === "about:blank" && status !== 401 && status !== 403) return rawType;
  }
  if (status === 401) return PROBLEM_TYPES.notAuthenticated;
  return rawType ?? PROBLEM_TYPES.unknown;
}

function defaultTitle(status: number): string {
  switch (status) {
    case 400:
      return "Invalid request";
    case 401:
      return "Sign-in required";
    case 403:
      return "Not allowed";
    case 404:
      return "Not found";
    case 409:
      return "Conflict";
    case 429:
      return "Too many requests";
    default:
      return status >= 500 ? "Something went wrong" : "Request failed";
  }
}

/**
 * Parse an error response body into ProblemDetails. Accepts:
 *  - RFC 9457 objects (`{type,title,status,detail,errors,request_id}`)
 *  - allauth envelopes (`{status, errors:[{message,code,param}]}`)
 *  - DRF-style `{detail}` and `{code, message}` bodies
 *  - anything else (plain text, empty) -> generic problem for the HTTP status
 */
export function parseProblem(status: number, body: unknown): ProblemDetails {
  if (!isRecord(body)) {
    return { type: normaliseType(undefined, status), title: defaultTitle(status), status };
  }
  const resolvedStatus = num(body.status) ?? status;
  const errors = normaliseFieldErrors(body.errors);
  const rawType = str(body.type) ?? str(body.code);
  const isAllauth = !str(body.type) && Array.isArray(body.errors);
  const type = isAllauth && resolvedStatus === 400 ? PROBLEM_TYPES.validationError : normaliseType(rawType, resolvedStatus);
  const detail = str(body.detail) ?? str(body.message) ?? (errors && errors.length === 1 ? errors[0]?.message : undefined);
  return {
    type,
    title: str(body.title) ?? defaultTitle(resolvedStatus),
    status: resolvedStatus,
    ...(detail ? { detail } : {}),
    ...(errors ? { errors } : {}),
    ...(str(body.request_id) ? { request_id: str(body.request_id) } : {}),
  };
}

export class ApiError extends Error {
  readonly problem: ProblemDetails;
  readonly status: number;

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = "ApiError";
    this.problem = problem;
    this.status = problem.status;
  }

  get type(): string {
    return this.problem.type;
  }

  get isReauthRequired(): boolean {
    return this.status === 403 && this.type === PROBLEM_TYPES.reauthRequired;
  }

  get isNotAuthenticated(): boolean {
    return (this.status === 401 || this.status === 403) && this.type === PROBLEM_TYPES.notAuthenticated;
  }

  get isValidation(): boolean {
    return this.status === 400 && Array.isArray(this.problem.errors);
  }

  /** Field errors keyed by field name (first message wins). */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.problem.errors ?? []) {
      if (!(e.field in out)) out[e.field] = e.message;
    }
    return out;
  }

  /** Human-readable one-line summary for toasts. */
  summary(): string {
    if (this.problem.detail) return this.problem.detail;
    const first = this.problem.errors?.[0];
    if (first) return first.field === "non_field_errors" ? first.message : `${first.field}: ${first.message}`;
    return this.problem.title;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Turn any thrown value into a display string. */
export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (isApiError(error)) return error.summary();
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
