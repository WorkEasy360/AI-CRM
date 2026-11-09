import { describe, expect, it } from "vitest";
import { defaultFollowUpTime, dueLabel } from "@/lib/crm/due-date";

describe("defaultFollowUpTime", () => {
  it("is tomorrow at 10:00, across a month end", () => {
    expect(defaultFollowUpTime(new Date(2026, 10, 9, 15, 0))).toBe("2026-11-10T10:00");
    expect(defaultFollowUpTime(new Date(2026, 11, 31, 15, 0))).toBe("2027-01-01T10:00");
  });
});

describe("dueLabel", () => {
  const now = new Date(2026, 10, 9, 15, 0);

  it("names today and tomorrow by the calendar day, not by 24-hour distance", () => {
    expect(dueLabel(new Date(2026, 10, 9, 0, 5).toISOString(), now)).toEqual({ text: "Today", tone: "today" });
    expect(dueLabel(new Date(2026, 10, 9, 23, 55).toISOString(), now)).toEqual({ text: "Today", tone: "today" });
    expect(dueLabel(new Date(2026, 10, 10, 0, 5).toISOString(), now)).toEqual({ text: "Tomorrow", tone: "tomorrow" });
  });

  it("marks earlier days overdue and later days neutral, with the date as the text", () => {
    expect(dueLabel(new Date(2026, 10, 8, 23, 0).toISOString(), now).tone).toBe("overdue");
    expect(dueLabel(new Date(2026, 10, 20, 9, 0).toISOString(), now).tone).toBe("later");
    expect(dueLabel(new Date(2026, 10, 20, 9, 0).toISOString(), now).text).toMatch(/20/);
  });
});
