"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Image as ImageIcon, Paperclip, Trash2, Upload } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { deleteFile, fileDownloadUrl, listFiles, uploadFile } from "@/lib/api/crm";
import type { EntityType, FileAttachment } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { can, scopeOf } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { cn, formatDateTime } from "@/lib/utils";

const MAX_BYTES = 10 * 1024 * 1024;
/** Mirrors ``apps.files.models.ALLOWED_CONTENT_TYPES``; the API is the enforcement point. */
const ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(contentType: string) {
  if (contentType.startsWith("image/")) return <ImageIcon className="size-4" aria-hidden />;
  if (contentType === "application/pdf" || contentType.startsWith("text/")) return <FileText className="size-4" aria-hidden />;
  return <Paperclip className="size-4" aria-hidden />;
}

/** Files attached to one record: list, upload (drag or pick), download and remove. */
export function FilesPanel({ entity, recordId, disabled = false }: { entity: EntityType; recordId: string; disabled?: boolean }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const [deleting, setDeleting] = React.useState<FileAttachment | null>(null);

  const key = crmKeys.files(entity, recordId);
  const files = useQuery({ queryKey: key, queryFn: () => listFiles(entity, recordId) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const canUpload = !disabled && can(active, "files.upload");
  const deleteScope = scopeOf(active, "files.delete");

  const upload = useMutation({
    mutationFn: (file: File) => uploadFile({ entity_type: entity, entity_id: recordId, file }),
    onSuccess: async () => {
      await refresh();
      toast({ tone: "success", title: "File uploaded" });
    },
    onError: (err) => toast({ tone: "error", title: "Could not upload file", description: errorMessage(err) }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteFile(id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
    onError: (err) => toast({ tone: "error", title: "Could not delete file", description: errorMessage(err) }),
  });

  const accept = (list: FileList | null) => {
    const file = list?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast({ tone: "error", title: "File too large", description: "Files are limited to 10 MB each." });
      return;
    }
    upload.mutate(file);
  };

  const canDelete = (file: FileAttachment) => {
    if (disabled || !deleteScope) return false;
    if (deleteScope === "all") return true;
    return Boolean(file.uploaded_by?.id) && file.uploaded_by?.id === active?.membership_id;
  };

  const items = files.data?.results ?? [];

  return (
    <section aria-label="Files" className="flex flex-col gap-4">
      {canUpload ? (
        <div
          className={cn(
            "flex flex-col items-center gap-2 rounded-md border border-dashed border-border-strong bg-surface px-4 py-6 text-center transition-colors",
            dragging && "border-primary bg-primary-soft/40",
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            accept(e.dataTransfer.files);
          }}
        >
          <Upload className="size-5 text-fg-subtle" aria-hidden />
          <p className="text-sm text-fg-muted">Drop a file here, or</p>
          <Button type="button" size="sm" variant="secondary" onClick={() => inputRef.current?.click()} loading={upload.isPending}>
            Choose a file
          </Button>
          <p className="text-xs text-fg-subtle">PDF, image, text or Office document · up to 10 MB</p>
          <input
            ref={inputRef}
            type="file"
            className="sr-only"
            accept={ACCEPT}
            aria-label="Upload a file"
            onChange={(e) => {
              accept(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      ) : null}

      {files.isPending ? (
        <SkeletonRows rows={2} />
      ) : items.length === 0 ? (
        <EmptyState icon={<Paperclip />} title="No files yet" description="Proposals, contracts and anything else this deal needs live here." className="py-8" />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((file) => (
            <li key={file.id} className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2">
              <span className="text-fg-subtle">{fileIcon(file.content_type)}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.filename}</p>
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
                  <span>{formatBytes(file.size_bytes)}</span>
                  <span aria-hidden>·</span>
                  <span className="inline-flex items-center gap-1">
                    {file.uploaded_by ? <Avatar name={file.uploaded_by.display_name} size="sm" className="size-4 text-[9px]" /> : null}
                    {file.uploaded_by?.display_name ?? "Unknown"}
                  </span>
                  <span aria-hidden>·</span>
                  <span>{formatDateTime(file.created_at)}</span>
                </div>
              </div>
              <Button asChild variant="ghost" size="sm" aria-label={`Download ${file.filename}`}>
                {/* The API answers with an attachment disposition; no new tab, no inline rendering. */}
                <a href={fileDownloadUrl(file.id)} download={file.filename}>
                  <Download />
                </a>
              </Button>
              {canDelete(file) ? (
                <Button variant="ghost" size="sm" aria-label={`Delete ${file.filename}`} onClick={() => setDeleting(file)}>
                  <Trash2 />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.filename ?? "this file"}?`}
        description="The file is removed for everyone and cannot be restored."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
      />
    </section>
  );
}
