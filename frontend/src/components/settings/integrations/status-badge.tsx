import * as React from "react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import type {
  ApiCredentialStatus,
  CatalogStatus,
  ConnectionStatus,
  DeliveryStatus,
  SyncJobStatus,
  WebhookStatus,
} from "@/lib/api/integrations";

type BadgeSpec = { label: string; variant: BadgeProps["variant"] };

const CONNECTION: Record<ConnectionStatus, BadgeSpec> = {
  connected: { label: "Connected", variant: "success" },
  action_required: { label: "Action required", variant: "warning" },
  error: { label: "Error", variant: "danger" },
  disabled: { label: "Paused", variant: "neutral" },
  syncing: { label: "Syncing", variant: "primary" },
  disconnected: { label: "Disconnected", variant: "neutral" },
};

const CATALOG: Record<CatalogStatus, BadgeSpec> = {
  connected: { label: "Connected", variant: "success" },
  action_required: { label: "Action required", variant: "warning" },
  available: { label: "Not connected", variant: "neutral" },
};

const JOB: Record<SyncJobStatus, BadgeSpec> = {
  pending: { label: "Queued", variant: "neutral" },
  processing: { label: "Running", variant: "primary" },
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Failed", variant: "danger" },
};

const DELIVERY: Record<DeliveryStatus, BadgeSpec> = {
  pending: { label: "Pending", variant: "neutral" },
  succeeded: { label: "Delivered", variant: "success" },
  skipped: { label: "Nothing to send", variant: "neutral" },
  failed: { label: "Failed", variant: "danger" },
  dead: { label: "Gave up after retries", variant: "danger" },
};

const WEBHOOK: Record<WebhookStatus, BadgeSpec> = {
  active: { label: "Active", variant: "success" },
  paused: { label: "Paused", variant: "neutral" },
  disabled: { label: "Turned off after failures", variant: "danger" },
};

const API_KEY: Record<ApiCredentialStatus, BadgeSpec> = {
  active: { label: "Active", variant: "success" },
  expired: { label: "Expired", variant: "warning" },
  revoked: { label: "Revoked", variant: "neutral" },
};

function SpecBadge({ spec, fallback }: { spec: BadgeSpec | undefined; fallback: string }) {
  return <Badge variant={spec?.variant ?? "neutral"}>{spec?.label ?? fallback}</Badge>;
}

export function connectionStatusLabel(status: ConnectionStatus): string {
  return CONNECTION[status]?.label ?? status;
}

export function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  return <SpecBadge spec={CONNECTION[status]} fallback={status} />;
}

export function CatalogStatusBadge({ status }: { status: CatalogStatus }) {
  return <SpecBadge spec={CATALOG[status]} fallback={status} />;
}

export function SyncJobStatusBadge({ status }: { status: SyncJobStatus }) {
  return <SpecBadge spec={JOB[status]} fallback={status} />;
}

export function DeliveryStatusBadge({ status, retrying }: { status: DeliveryStatus; retrying?: boolean }) {
  if (status === "pending" && retrying) return <Badge variant="warning">Retrying</Badge>;
  return <SpecBadge spec={DELIVERY[status]} fallback={status} />;
}

export function WebhookStatusBadge({ status }: { status: WebhookStatus }) {
  return <SpecBadge spec={WEBHOOK[status]} fallback={status} />;
}

export function ApiKeyStatusBadge({ status }: { status: ApiCredentialStatus }) {
  return <SpecBadge spec={API_KEY[status]} fallback={status} />;
}
