import { describe, expect, it } from "vitest";
import { NO_REPEAT, buildRrule, describeRrule, parseRrule, recurrenceError, weekdayOf } from "@/components/activities/recurrence";

describe("RRULE builder", () => {
  it("returns an empty rule when it does not repeat", () => {
    expect(buildRrule(NO_REPEAT)).toBe("");
  });

  it("builds frequency, interval, weekdays and an end", () => {
    expect(buildRrule({ ...NO_REPEAT, freq: "daily" })).toBe("FREQ=DAILY");
    expect(buildRrule({ ...NO_REPEAT, freq: "weekly", days: ["WE", "MO"], end: "count", count: 4 })).toBe("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4");
    expect(buildRrule({ ...NO_REPEAT, freq: "monthly", interval: 2 })).toBe("FREQ=MONTHLY;INTERVAL=2");
    // Weekdays only belong to weekly rules.
    expect(buildRrule({ ...NO_REPEAT, freq: "yearly", days: ["MO"] })).toBe("FREQ=YEARLY");
  });

  it("writes UNTIL as the end of the chosen local day, in UTC", () => {
    const rule = buildRrule({ ...NO_REPEAT, freq: "weekly", end: "until", until: "2026-12-31" });
    const until = /UNTIL=(\d{8}T\d{6}Z)$/.exec(rule)?.[1] ?? "";
    const expected = new Date(2026, 11, 31, 23, 59, 59);
    const iso = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}T${until.slice(9, 11)}:${until.slice(11, 13)}:${until.slice(13, 15)}Z`;
    expect(new Date(iso).getTime()).toBe(expected.getTime());
  });

  it("keeps a custom rule untouched", () => {
    expect(buildRrule(parseRrule("FREQ=MONTHLY;BYDAY=1MO"))).toBe("FREQ=MONTHLY;BYDAY=1MO");
  });
});

describe("RRULE parser", () => {
  it("parses an empty rule as no repeat", () => {
    expect(parseRrule("").freq).toBe("none");
    expect(parseRrule(null).freq).toBe("none");
  });

  it("parses weekly days, interval and count", () => {
    expect(parseRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR,MO;COUNT=10")).toMatchObject({ freq: "weekly", interval: 2, days: ["MO", "FR"], end: "count", count: 10 });
  });

  it("accepts an RRULE: prefix and lower case", () => {
    expect(parseRrule("RRULE:freq=daily")).toMatchObject({ freq: "daily", interval: 1, end: "never" });
  });

  it("round-trips UNTIL back to the same local date", () => {
    const rule = buildRrule({ ...NO_REPEAT, freq: "daily", end: "until", until: "2027-03-05" });
    expect(parseRrule(rule)).toMatchObject({ freq: "daily", end: "until", until: "2027-03-05" });
    expect(parseRrule("FREQ=DAILY;UNTIL=20270305")).toMatchObject({ end: "until", until: "2027-03-05" });
  });

  it("marks rules the control cannot show as custom", () => {
    for (const rule of ["FREQ=MONTHLY;BYMONTHDAY=15", "FREQ=MONTHLY;BYDAY=-1FR", "FREQ=HOURLY", "FREQ=DAILY;COUNT=2;UNTIL=20270101", "nonsense"]) {
      expect(parseRrule(rule)).toMatchObject({ freq: "custom", raw: rule });
    }
  });

  it("round-trips the rules it builds", () => {
    for (const rule of ["FREQ=DAILY", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "FREQ=MONTHLY;INTERVAL=3;COUNT=12", "FREQ=YEARLY;COUNT=1000"]) {
      expect(buildRrule(parseRrule(rule))).toBe(rule);
    }
  });
});

describe("recurrence helpers", () => {
  it("flags values outside the API limits", () => {
    expect(recurrenceError("")).toBeNull();
    expect(recurrenceError("FREQ=WEEKLY;BYDAY=MO;COUNT=4")).toBeNull();
    expect(recurrenceError("FREQ=DAILY;COUNT=0")).toBe("Enter 1 to 1000 times.");
    expect(recurrenceError("FREQ=DAILY;COUNT=1001")).toBe("Enter 1 to 1000 times.");
    expect(recurrenceError("FREQ=DAILY;INTERVAL=0")).toBe("Repeat every 1 to 366.");
    expect(recurrenceError("FREQ=DAILY;UNTIL=")).toBe("Pick an end date.");
  });

  it("describes a rule in plain words", () => {
    expect(describeRrule("")).toBe("");
    expect(describeRrule("FREQ=DAILY")).toBe("Daily");
    expect(describeRrule("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4")).toBe("Weekly on Mon, Wed · 4 times");
    expect(describeRrule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")).toBe("Weekly on weekdays");
    expect(describeRrule("FREQ=MONTHLY;INTERVAL=2;COUNT=1")).toBe("Every 2 months · 1 time");
    expect(describeRrule("FREQ=MONTHLY;BYMONTHDAY=1")).toBe("Repeats (custom)");
  });

  it("maps a date to its RRULE weekday", () => {
    expect(weekdayOf(new Date(2026, 8, 14))).toBe("MO");
    expect(weekdayOf(new Date(2026, 8, 20))).toBe("SU");
  });
});
