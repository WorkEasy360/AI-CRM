import { api } from "@/lib/api/client";
import type { Paginated } from "@/lib/api/types";

export const AUTOMATION_TRIGGERS = ["contact_created", "deal_created", "deal_stage_entered", "deal_won", "deal_lost"] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];
export const AUTOMATION_ACTIONS = ["create_task", "notify_owner", "notify_team", "send_whatsapp"] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

export const TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  contact_created: "A new contact (lead) is added",
  deal_created: "A new deal is created",
  deal_stage_entered: "A deal enters a stage",
  deal_won: "A deal is won",
  deal_lost: "A deal is lost",
};
export const ACTION_LABELS: Record<AutomationAction, string> = {
  create_task: "Create a follow-up task for the owner",
  notify_owner: "Notify the owner",
  notify_team: "Notify the owner's team",
  send_whatsapp: "Send a WhatsApp template to the contact",
};

/** Merge fields a WhatsApp template value may use; filled per contact when the message goes out. */
export const MERGE_FIELDS = ["{{first_name}}", "{{last_name}}", "{{full_name}}", "{{company}}", "{{deal_name}}", "{{owner_name}}"] as const;

export interface AutomationRule {
  id: string;
  name: string;
  description: string;
  trigger: AutomationTrigger;
  /** For deal_stage_entered: the stage the deal has to enter. */
  stage_id: string | null;
  stage_name: string | null;
  action: AutomationAction;
  message: string;
  delay_days: number;
  /** Wait ``delay_days`` and skip when the contact has written back meanwhile. */
  only_if_no_reply: boolean;
  whatsapp_template_id: string | null;
  whatsapp_template_name: string | null;
  template_params: string[];
  is_enabled: boolean;
  /** Runs waiting for their delay (or for access to be renewed). */
  pending_runs: number;
  last_outcome: "done" | "skipped" | null;
  last_detail: string | null;
  run_count: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AutomationRuleInput = Partial<
  Pick<AutomationRule, "name" | "description" | "trigger" | "action" | "message" | "delay_days" | "is_enabled" | "only_if_no_reply" | "whatsapp_template_id" | "template_params" | "stage_id">
>;

export const automationKeys = { rules: ["automation", "rules"] as const };

const enc = encodeURIComponent;

/** One page holds every rule: the edition caps the count well below the page size. */
export const listAutomationRules = () => api.get<Paginated<AutomationRule>>("/api/v1/automation-rules/").then((page) => page.results);
export const createAutomationRule = (input: AutomationRuleInput) => api.post<AutomationRule>("/api/v1/automation-rules/", input);
export const updateAutomationRule = (id: string, input: AutomationRuleInput) => api.patch<AutomationRule>(`/api/v1/automation-rules/${enc(id)}/`, input);
export const deleteAutomationRule = (id: string) => api.delete(`/api/v1/automation-rules/${enc(id)}/`);
