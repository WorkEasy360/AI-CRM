import type { Metadata } from "next";
import { SettingsIndex } from "@/components/settings/settings-index";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsIndexPage() {
  return <SettingsIndex />;
}
