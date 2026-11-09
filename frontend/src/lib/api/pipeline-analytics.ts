import { api } from "@/lib/api/client";
import type { ListParams } from "@/lib/api/crm-types";

interface Window {
  created: number;
  won: number;
  lost: number;
  win_rate: number | null;
  avg_cycle_days: number | null;
}

/** Pipeline page KPIs. Money is null when the member may not see deal amounts. */
export interface PipelineStats {
  pipeline: { id: string; name: string } | null;
  days: number;
  total_deals: number;
  open_deals: number;
  pipeline_value: string | null;
  expected_revenue: string | null;
  /** Over the deals as filtered: `closed_period` narrows these to deals closed in that period. */
  won_deals: number;
  lost_deals: number;
  won_amount: string | null;
  lost_amount: string | null;
  /** Won as a percentage of won + lost; null when nothing closed. */
  conversion_rate: number | null;
  current: Window;
  previous: Window;
}

export interface PipelineAnalytics {
  pipeline: { id: string; name: string } | null;
  conversion: { id: string; name: string; kind: string; color_token: string; reached: number; current: number; rate: number | null }[];
  win_loss: {
    won: number;
    lost: number;
    open: number;
    win_rate: number | null;
    won_amount: string | null;
    lost_amount: string | null;
    lost_reasons: { reason: string; count: number }[];
  };
  sources: { source: string; label: string; count: number; won: number; won_amount: string | null }[];
  owners: { id: string; name: string; deals: number; won: number; win_rate: number | null; won_amount: string | null }[];
}

export const pipelineKeys = {
  stats: (pipelineId: string | undefined, params: ListParams) => ["crm", "deals", "pipeline-stats", pipelineId ?? "default", params] as const,
  analytics: (pipelineId: string | undefined, params: ListParams) => ["crm", "deals", "analytics", pipelineId ?? "default", params] as const,
};

export const getPipelineStats = (pipelineId: string | undefined, params: ListParams = {}) =>
  api.get<PipelineStats>("/api/v1/deals/pipeline-stats/", { ...params, pipeline: pipelineId });
export const getPipelineAnalytics = (pipelineId: string | undefined, params: ListParams = {}) =>
  api.get<PipelineAnalytics>("/api/v1/deals/analytics/", { ...params, pipeline: pipelineId });
