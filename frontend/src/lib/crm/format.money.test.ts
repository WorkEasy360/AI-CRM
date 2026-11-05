import { describe, expect, it } from "vitest";
import { formatCompactMoney, formatMoney } from "@/lib/crm/format";

describe("formatMoney for rupees", () => {
  it("uses Indian grouping without paise for whole amounts", () => {
    expect(formatMoney("12450000.00", "INR")).toBe("₹1,24,50,000");
    expect(formatMoney(500000.5, "INR")).toBe("₹5,00,000.5");
  });

  it("shortens to lakhs and crores", () => {
    expect(formatCompactMoney(6280000, "INR")).toBe("₹62.8L");
    expect(formatCompactMoney(12450000, "INR")).toBe("₹1.2Cr");
    expect(formatCompactMoney(4500, "INR")).toBe("₹4.5K");
  });
});
