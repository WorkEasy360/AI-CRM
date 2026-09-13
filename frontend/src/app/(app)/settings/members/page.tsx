import { redirect } from "next/navigation";

/** Kept so old links keep working; the page now lives under Settings / Users. */
export default function MembersRedirect() {
  redirect("/settings/users");
}
