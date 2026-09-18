import { z } from "zod";
import { ROLE_KEYS } from "@/lib/api/types";

export const emailSchema = z.email("Enter a valid email address.").max(254, "Email is too long.");

/** Mirrors the server policy (Django validators: 12+ characters, not common, not all digits, not like the email). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters. Avoid common passwords and your name or email.`;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(128, "Password is too long.");

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app.");

export const roleSchema = z.enum(ROLE_KEYS, { message: "Choose a role." });

export const inviteSchema = z.object({
  name: z.string().trim().max(120, "Name is too long.").optional(),
  email: emailSchema,
  role: roleSchema,
  team_id: z.string().optional(),
});
export type InviteInput = z.infer<typeof inviteSchema>;

export const nameSchema = z.string().trim().min(1, "Enter your name.").max(120, "Name is too long.");

export const organizationNameSchema = z.string().trim().min(2, "Name must be at least 2 characters.").max(120, "Name is too long.");

export const teamNameSchema = z.string().trim().min(1, "Team name is required.").max(80, "Team name is too long.");
