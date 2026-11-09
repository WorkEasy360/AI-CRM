/** E.164 allows at most 15 digits; 8 is the shortest number worth treating as dialable with its country code. */
const MIN_INTERNATIONAL = 8;
const MAX_INTERNATIONAL = 15;

/**
 * A phone number as wa.me and tel: links want it: digits only, with a country code. A bare 10-digit number
 * is taken as Indian. One written with "+" or "00" already has its country code, so it is never prefixed:
 * +65 8123 4567 stays Singaporean. Returns null when no usable number is left.
 */
export function toWhatsAppNumber(raw: string | null | undefined): string | null {
  const text = raw?.trim() ?? "";
  const international = text.startsWith("+") || text.startsWith("00");
  const digits = text.replace(/\D/g, "").replace(/^0+/, "");
  if (!international && digits.length === 10) return `91${digits}`;
  const minimum = international ? MIN_INTERNATIONAL : 11;
  return digits.length >= minimum && digits.length <= MAX_INTERNATIONAL ? digits : null;
}

export function whatsAppUrl(number: string, text?: string): string {
  return `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}
