import { describe, expect, it } from "vitest";
import { visibleSettingsCards } from "@/components/settings/settings-index";
import type { ActiveContext } from "@/lib/api/types";

const active = (permissions: Record<string, string>) => ({ permissions }) as unknown as ActiveContext;

const OWNER = Object.fromEntries(
  [
    "org.update",
    "members.invite",
    "roles.manage",
    "pipelines.manage",
    "customfields.manage",
    "tags.manage",
    "email.view",
    "whatsapp.view",
    "ai.settings.manage",
    "audit.view",
    "integrations.view",
    "contacts.import",
    "automation.view",
    "org.billing",
    "pricebooks.manage",
  ].map((key) => [key, "all"]),
);

describe("Settings home", () => {
  it("shows the six groups to an owner, in the WorkEasy360 order", () => {
    const { cards, more } = visibleSettingsCards(active(OWNER));
    expect(cards.map((c) => c.title)).toEqual(["Workspace", "CRM Configuration", "Communication", "AI Assistant", "Security & Data", "Integrations & API"]);
    expect(cards[5]?.items.map((i) => i.label)).toEqual(["Integrations (Connected Apps)", "API Keys", "Webhooks"]);
    expect(more.map((i) => i.label)).toEqual(["Automation", "Billing & Subscription", "Price books"]);
  });

  it("keeps only what a member may open", () => {
    const { cards, more } = visibleSettingsCards(active({}));
    expect(cards.map((c) => c.title)).toEqual(["Communication", "Security & Data"]);
    expect(cards[0]?.items.map((i) => i.label)).toEqual(["Notifications"]);
    expect(cards[1]?.items.map((i) => i.label)).toEqual(["Password & 2FA"]);
    expect(more).toEqual([]);
  });
});
