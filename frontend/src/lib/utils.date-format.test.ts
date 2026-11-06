import { afterEach, describe, expect, it } from "vitest";
import { formatDate, formatDateTime, setWorkspaceDateFormat } from "@/lib/utils";

describe("workspace date format", () => {
  afterEach(() => setWorkspaceDateFormat(null));

  it("formats dates in the format chosen in General settings", () => {
    const day = "2026-11-04T12:00:00";
    setWorkspaceDateFormat("DD/MM/YYYY");
    expect(formatDate(day)).toBe("04/11/2026");
    setWorkspaceDateFormat("MM/DD/YYYY");
    expect(formatDate(day)).toBe("11/04/2026");
    setWorkspaceDateFormat("YYYY-MM-DD");
    expect(formatDate(day)).toBe("2026-11-04");
    expect(formatDateTime(day)).toMatch(/^2026-11-04, /);
    setWorkspaceDateFormat("DD MMM YYYY");
    expect(formatDate(day)).toMatch(/^04 Nov\.? 2026$/);
  });

  it("ignores an unknown format and keeps the viewer's locale", () => {
    setWorkspaceDateFormat("%Y");
    const locale = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date("2026-11-04T12:00:00"));
    expect(formatDate("2026-11-04T12:00:00")).toBe(locale);
  });
});
