/** Small static reference lists used by organisation forms. */
export const CURRENCIES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "USD", name: "US Dollar" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British Pound" },
  { code: "AUD", name: "Australian Dollar" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "CHF", name: "Swiss Franc" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "INR", name: "Indian Rupee" },
  { code: "SGD", name: "Singapore Dollar" },
  { code: "AED", name: "UAE Dirham" },
  { code: "BRL", name: "Brazilian Real" },
  { code: "MXN", name: "Mexican Peso" },
  { code: "ZAR", name: "South African Rand" },
  { code: "SEK", name: "Swedish Krona" },
  { code: "NOK", name: "Norwegian Krone" },
  { code: "DKK", name: "Danish Krone" },
  { code: "PLN", name: "Polish Zloty" },
  { code: "NZD", name: "New Zealand Dollar" },
];

const FALLBACK_TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Madrid",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** IANA time zones from the runtime when available, otherwise a curated list. */
export function timezoneOptions(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const values = intl.supportedValuesOf?.("timeZone");
    if (values && values.length > 0) return values.includes("UTC") ? values : ["UTC", ...values];
  } catch {
    /* fall through */
  }
  return FALLBACK_TIMEZONES;
}

export function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
