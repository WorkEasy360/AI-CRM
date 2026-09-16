"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { isVersionConflict } from "@/components/crm/use-record-mutations";
import { moveDealStage } from "@/lib/api/crm";
import type { Deal, DealCard, StageKind } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";

/** The subset of a stage the move flow needs (board stages, pipeline stages and stage refs all fit). */
export interface StageTarget {
  id: string;
  name: string;
  kind: StageKind;
}

export interface MoveStageVars {
  /** A board card is enough: the move needs id, version, name and the current stage. A full `Deal`
      (from the deal page) satisfies `DealCard`, so both callers pass their own object unchanged. */
  deal: DealCard;
  stage: StageTarget;
  lostReason?: string;
}

export const CONFLICT_TITLE = "Someone else changed this deal";
export const CONFLICT_DESCRIPTION = "The board was refreshed with the latest version. Try the move again.";

const MAX_LOST_REASON = 255;

/**
 * Small prompt shown before a deal is dropped into a `lost` stage. The reason is optional; the
 * dialog only collects it and hands it back to the caller.
 */
export function MoveStageDialog({
  open,
  stage,
  dealName,
  loading,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  stage: StageTarget | null;
  dealName: string;
  loading?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (lostReason: string) => void;
}) {
  const [reason, setReason] = React.useState("");
  const id = React.useId();

  React.useEffect(() => {
    if (open) setReason("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm(reason.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>Mark as lost?</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-fg">{dealName}</span> will move to {stage?.name ?? "the lost stage"} and be closed. You can
              reopen it later by moving it back to an open stage.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id}>Lost reason (optional)</Label>
            <Textarea
              id={id}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={MAX_LOST_REASON}
              rows={3}
              placeholder="Budget cut, chose a competitor, timing…"
              autoFocus
            />
            <span className="text-xs text-fg-subtle">
              {reason.length} / {MAX_LOST_REASON}
            </span>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={loading}>
              Mark as lost
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Stage-move flow shared by the board and the deal page. `requestMove` prompts for a lost reason
 * when the target is a lost stage, otherwise it moves right away. Errors are toasted; a 409
 * version conflict refreshes the board and record caches so the next attempt uses fresh data.
 */
export function useMoveStage(options?: {
  onMutate?: (vars: MoveStageVars) => void;
  onSuccess?: (deal: Deal, vars: MoveStageVars) => void;
  onError?: (error: unknown, vars: MoveStageVars) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [prompt, setPrompt] = React.useState<{ deal: DealCard; stage: StageTarget } | null>(null);
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const invalidate = React.useCallback(
    (dealId: string) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["crm", "deals", "board"] }),
        queryClient.invalidateQueries({ queryKey: ["crm", "deals", "list"] }),
        queryClient.invalidateQueries({ queryKey: crmKeys.record("deals", dealId) }),
        queryClient.invalidateQueries({ queryKey: crmKeys.dealHistory(dealId) }),
        queryClient.invalidateQueries({ queryKey: crmKeys.timeline("deal", dealId) }),
      ]),
    [queryClient],
  );

  const mutation = useMutation({
    mutationFn: ({ deal, stage, lostReason }: MoveStageVars) => moveDealStage(deal.id, deal.version, stage.id, lostReason),
    onMutate: (vars) => optionsRef.current?.onMutate?.(vars),
    onSuccess: async (updated, vars) => {
      await invalidate(vars.deal.id);
      setPrompt(null);
      optionsRef.current?.onSuccess?.(updated, vars);
    },
    onError: async (error, vars) => {
      setPrompt(null);
      optionsRef.current?.onError?.(error, vars);
      if (isVersionConflict(error)) {
        await invalidate(vars.deal.id);
        toast({ tone: "error", title: CONFLICT_TITLE, description: CONFLICT_DESCRIPTION });
      } else if (isApiError(error) && error.status === 403) {
        toast({ tone: "error", title: "Not allowed", description: "You cannot change the stage of this deal." });
      } else {
        toast({ tone: "error", title: "Could not move deal", description: errorMessage(error) });
      }
    },
  });

  const requestMove = React.useCallback(
    (deal: DealCard, stage: StageTarget) => {
      if (stage.id === deal.stage.id) return;
      if (stage.kind === "lost") {
        setPrompt({ deal, stage });
        return;
      }
      mutation.mutate({ deal, stage });
    },
    [mutation],
  );

  const dialog = (
    <MoveStageDialog
      open={prompt !== null}
      stage={prompt?.stage ?? null}
      dealName={prompt?.deal.name ?? ""}
      loading={mutation.isPending}
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) setPrompt(null);
      }}
      onConfirm={(lostReason) => {
        if (prompt) mutation.mutate({ deal: prompt.deal, stage: prompt.stage, lostReason: lostReason || undefined });
      }}
    />
  );

  return { requestMove, dialog, isPending: mutation.isPending, pendingDealId: mutation.isPending ? mutation.variables?.deal.id : undefined };
}
