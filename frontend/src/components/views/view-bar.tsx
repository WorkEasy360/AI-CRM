"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Bookmark, CalendarDays, Check, ChevronDown, KanbanSquare, List, Sheet, Star, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { listTeams } from "@/lib/api/endpoints";
import type { EntityType, ListParams, SavedView, ViewKind, ViewVisibility } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { VIEW_KINDS, VIEW_LABELS, applySavedView, savedViewInputFrom, useDefaultView, useSavedViews } from "@/lib/views";

const KIND_ICONS: Record<ViewKind, React.ReactNode> = {
  list: <List />,
  kanban: <KanbanSquare />,
  sheet: <Sheet />,
  calendar: <CalendarDays />,
  chart: <BarChart3 />,
};

/**
 * The five view modes of a module and its saved views (filters, columns, sort and per-mode settings,
 * private or shared, one default per member). Everything lives in the page URL; a saved view is a
 * named copy of it.
 */
export function ViewBar({
  entity,
  kind,
  params,
  setParams,
  ownedKeys = [],
  extraFilterKeys = [],
  defaultKind = "list",
}: {
  entity: EntityType;
  kind: ViewKind;
  /** The mode the page shows when the URL names none (it is kept out of the URL). */
  defaultKind?: ViewKind;
  params: ListParams;
  setParams: (patch: ListParams) => void;
  /** URL keys the page keeps when a saved view is opened (e.g. the selected pipeline). */
  ownedKeys?: readonly string[];
  /** Page keys that are filters too (e.g. `pipeline` on the deals page). */
  extraFilterKeys?: readonly string[];
}) {
  const { data: session } = useSession();
  const canShare = can(session?.active ?? null, "views.share");
  const { toast } = useToast();
  const { views, create, update, remove, makeDefault, clearDefault } = useSavedViews(entity);
  const list = React.useMemo(() => views.data?.results ?? [], [views.data]);
  const current = list.find((v) => v.id === params.saved) ?? null;
  const [saveOpen, setSaveOpen] = React.useState(false);

  const open = React.useCallback(
    (view: SavedView) => setParams(applySavedView(view, params, ownedKeys)),
    [setParams, params, ownedKeys],
  );
  useDefaultView(views.data?.results, params, open, ownedKeys);

  const fail = (title: string) => (error: unknown) => toast({ tone: "error", title, description: errorMessage(error) });

  const saveChanges = () => {
    if (!current) return;
    const input = savedViewInputFrom(params, kind, extraFilterKeys);
    update.mutate(
      { id: current.id, input: { ...input, version: current.version } },
      { onSuccess: () => toast({ tone: "success", title: `Saved "${current.name}"` }), onError: fail("Could not save the view") },
    );
  };

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <div className="inline-flex h-8 items-center gap-0.5 rounded-sm bg-bg-subtle p-0.5" role="group" aria-label="View">
        {VIEW_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setParams({ view: k === defaultKind ? undefined : k })}
            aria-pressed={kind === k}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors [&_svg]:size-3.5",
              kind === k ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
            )}
          >
            {KIND_ICONS[k]}
            {VIEW_LABELS[k]}
          </button>
        ))}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" className="h-8">
            <Bookmark />
            <span className="max-w-40 truncate">{current ? current.name : "Saved views"}</span>
            <ChevronDown className="text-fg-subtle" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Saved views</DropdownMenuLabel>
          {list.length === 0 ? <p className="px-2 py-1.5 text-xs text-fg-subtle">No saved views yet.</p> : null}
          {list.map((v) => (
            <DropdownMenuItem key={v.id} onSelect={() => open(v)}>
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                {v.id === current?.id ? <Check className="size-3.5 text-primary" aria-hidden /> : <span className="w-3.5" />}
                <span className="truncate">{v.name}</span>
              </span>
              <span className="ml-2 flex shrink-0 items-center gap-1">
                {v.is_default ? <Star className="size-3 fill-current text-warning" aria-label="Your default" /> : null}
                <span className="text-[11px] text-fg-subtle">{VIEW_LABELS[v.kind]}</span>
                {v.visibility !== "private" ? <Badge className="px-1 py-0 text-[10px]">Shared</Badge> : null}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSaveOpen(true)}>Save as new view…</DropdownMenuItem>
          {current?.is_owner ? <DropdownMenuItem onSelect={saveChanges}>Save changes to “{current.name}”</DropdownMenuItem> : null}
          {current ? (
            current.is_default ? (
              <DropdownMenuItem onSelect={() => clearDefault.mutate(undefined, { onError: fail("Could not change your default") })}>
                Stop opening with this view
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => makeDefault.mutate(current.id, { onError: fail("Could not change your default") })}>
                Open {VIEW_LABELS[kind].toLowerCase()} with this view by default
              </DropdownMenuItem>
            )
          ) : null}
          {current?.is_owner ? (
            <DropdownMenuItem
              destructive
              onSelect={() =>
                remove.mutate(current.id, {
                  onSuccess: () => setParams({ saved: undefined }),
                  onError: fail("Could not delete the view"),
                })
              }
            >
              <Trash2 /> Delete view
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {current?.restricted ? (
        <span className="text-xs text-fg-subtle" title="Columns or filters that use fields you cannot see were left out.">
          Some of this view’s fields are not available to you.
        </span>
      ) : null}

      {saveOpen ? (
        <SaveViewDialog
          canShare={canShare}
          busy={create.isPending}
          onClose={() => setSaveOpen(false)}
          onSave={(name, visibility, teamIds, asDefault) => {
            const input = savedViewInputFrom(params, kind, extraFilterKeys);
            create.mutate(
              { ...input, name, visibility, team_ids: teamIds },
              {
                onSuccess: (view) => {
                  setSaveOpen(false);
                  setParams({ saved: view.id });
                  if (asDefault) makeDefault.mutate(view.id);
                  toast({ tone: "success", title: `Saved "${view.name}"` });
                },
                onError: fail("Could not save the view"),
              },
            );
          }}
        />
      ) : null}
    </div>
  );
}

function SaveViewDialog({
  canShare,
  busy,
  onClose,
  onSave,
}: {
  canShare: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (name: string, visibility: ViewVisibility, teamIds: string[], asDefault: boolean) => void;
}) {
  const [name, setName] = React.useState("");
  const [visibility, setVisibility] = React.useState<ViewVisibility>("private");
  const [teamIds, setTeamIds] = React.useState<string[]>([]);
  const [asDefault, setAsDefault] = React.useState(false);
  const teams = useQuery({ queryKey: ["teams", "all"], queryFn: () => listTeams(), enabled: canShare && visibility === "teams" });
  const valid = name.trim().length > 0 && (visibility !== "teams" || teamIds.length > 0);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save view</DialogTitle>
          <DialogDescription>Saves the current filters, columns, sort and view settings.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onSave(name.trim(), visibility, teamIds, asDefault);
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="view-name">Name</Label>
            <Input id="view-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          </div>
          {canShare ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="view-visibility">Who can use it</Label>
              <Select value={visibility} onValueChange={(v) => setVisibility(v as ViewVisibility)}>
                <SelectTrigger id="view-visibility" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Only me</SelectItem>
                  <SelectItem value="organization">Everyone</SelectItem>
                  <SelectItem value="teams">Selected teams</SelectItem>
                </SelectContent>
              </Select>
              {visibility === "teams" ? (
                <ul className="max-h-40 overflow-y-auto rounded-sm border border-border p-1" aria-label="Teams">
                  {(teams.data?.results ?? []).map((t) => {
                    const checked = teamIds.includes(t.id);
                    return (
                      <li key={t.id}>
                        <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-sm hover:bg-bg-subtle">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setTeamIds((ids) => (checked ? ids.filter((i) => i !== t.id) : [...ids, t.id]))}
                          />
                          {t.name}
                        </label>
                      </li>
                    );
                  })}
                  {teams.isSuccess && (teams.data?.results ?? []).length === 0 ? <li className="px-1.5 py-1 text-xs text-fg-subtle">No teams yet.</li> : null}
                </ul>
              ) : null}
            </div>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={asDefault} onCheckedChange={setAsDefault} aria-label="Open with this view by default" />
            Open with this view by default
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              Save view
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
