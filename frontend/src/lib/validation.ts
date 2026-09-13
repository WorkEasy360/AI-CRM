import { z } from "zod";
import { ROLE_KEYS } from "@/lib/api/types";

export const emailSchema = z.email("Enter a valid email address.").max(254, "Email is too long.");

export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(128, "Password is too long.");

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app.");

export const roleSchema = z.enum(ROLE_KEYS, { message: "Choose a role." });

export const inviteSchema = z.object({
  email: emailSchema,
  role: roleSchema,
});
export type InviteInput = z.infer<typeof inviteSchema>;

export const organizationNameSchema = z.string().trim().min(2, "Name must be at least 2 characters.").max(120, "Name is too long.");

export const teamNameSchema = z.string().trim().min(1, "Team name is required.").max(80, "Team name is too long.");
