import { describe, expect, it } from "vitest";
import { toWhatsAppNumber, whatsAppUrl } from "@/lib/phone";

describe("toWhatsAppNumber", () => {
  it.each([
    ["08828731121", "918828731121"],
    ["+91 88287 31121", "918828731121"],
    ["8828731121", "918828731121"],
    ["(882) 873-1121", "918828731121"],
    ["91-8828731121", "918828731121"],
    ["0091 88287 31121", "918828731121"],
  ])("makes %s an Indian number", (raw, expected) => {
    expect(toWhatsAppNumber(raw)).toBe(expected);
  });

  it("does not add India's code to a number that already has its own", () => {
    expect(toWhatsAppNumber("+65 8123 4567")).toBe("6581234567");
    expect(toWhatsAppNumber("+1 202 555 0123")).toBe("12025550123");
  });

  it.each([[null], [undefined], [""], ["   "], ["n/a"], ["12345"], ["0000000000"], ["+123"], ["1234567890123456"]])("rejects %s", (raw) => {
    expect(toWhatsAppNumber(raw)).toBeNull();
  });
});

describe("whatsAppUrl", () => {
  it("links to the number, encoding any prefilled text", () => {
    expect(whatsAppUrl("918828731121")).toBe("https://wa.me/918828731121");
    expect(whatsAppUrl("918828731121", "Hi Rahul, regarding A&B")).toBe("https://wa.me/918828731121?text=Hi%20Rahul%2C%20regarding%20A%26B");
  });
});
