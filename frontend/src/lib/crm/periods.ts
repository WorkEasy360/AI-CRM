/** "2026-11" for the month ``date`` falls in, on the viewer's clock. */
export function monthKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** The month before ``date``'s. */
export function previousMonthKey(date: Date = new Date()): string {
  return monthKey(new Date(date.getFullYear(), date.getMonth() - 1, 1));
}

/** "Nov 2026" for "2026-11", except the two months people call by name. */
export function monthName(key: string, now: Date = new Date()): string {
  if (key === monthKey(now)) return "This Month";
  if (key === previousMonthKey(now)) return "Last Month";
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(new Date(year!, month! - 1, 1));
}
