import { describe, expect, it } from "vitest";
import { launcherRedirect } from "@/lib/launcher";

const ORG = "7D0C7A52-9F43-4F0E-8A3B-1D2E3F4A5B6C";

describe("launcherRedirect", () => {
  it("sends the launcher entry point into Workeasy360 sign-in for the chosen organization", () => {
    const target = launcherRedirect(new URL(`https://crm.workeasy360.com/?organization=${ORG}`));
    expect(target?.toString()).toBe(
      `https://crm.workeasy360.com/api/auth/workeasy360/start?organization=${ORG.toLowerCase()}`,
    );
  });

  it("keeps the page as the place to land", () => {
    const target = launcherRedirect(new URL(`https://crm.workeasy360.com/deals?organization=${ORG}`));
    expect(target?.searchParams.get("next")).toBe("/deals");
  });

  it("ignores anything that is not a UUID", () => {
    expect(launcherRedirect(new URL("https://crm.workeasy360.com/?organization=acme"))).toBeNull();
    expect(launcherRedirect(new URL("https://crm.workeasy360.com/deals"))).toBeNull();
  });
});
