import { redirect } from "next/navigation";

/** Kept so old links keep working; the page now lives under Settings / General. */
export default function OrganizationRedirect() {
  redirect("/settings/general");
}
