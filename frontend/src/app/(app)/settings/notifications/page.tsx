import type { Metadata } from "next";
import { NotificationsSettingsPage } from "@/components/settings/notifications-settings-page";

export const metadata: Metadata = { title: "Notifications" };

export default function Page() {
  return <NotificationsSettingsPage />;
}
