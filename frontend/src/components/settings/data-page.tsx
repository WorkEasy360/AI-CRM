"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, DatabaseZap, Download, FileSpreadsheet, FileUp, Loader2, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  createExport,
  exportDownloadUrl,
  getImport,
  listExports,
  listImports,
  startImport,
  uploadImport,
  type ExportEntity,
  type ImportEntity,
} from "@/lib/api/crm";
import type { ExportJob, ImportJob, JobStatus } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { hasPermission, useSession } from "@/lib/session";
import { cn, formatDateTime } from "@/lib/utils";

const IMPORT_ENTITIES: { key: ImportEntity; label: string }[] = [
  { key: "contacts", label: "Contacts" },
  { key: "companies", label: "Companies" },
  { key: "products", label: "Products" },
];

const EXPORT_ENTITIES: { key: ExportEntity; label: string }[] = [
  { key: "contacts", label: "Contacts" },
  { key: "companies", label: "Companies" },
  { key: "deals", label: "Deals" },
  { key: "products", label: "Products" },
];

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
const POLL_MS = 2000;
/** Radix Select forbids an empty-string item value, so "skip" gets a sentinel that maps back to "". */
const SKIP = "__skip__";

function isImportEntity(value: string): value is ImportEntity {
  return IMPORT_ENTITIES.some((e) => e.key === value);
}
function isExportEntity(value: string): value is ExportEntity {
  return EXPORT_ENTITIES.some((e) => e.key === value);
}

function isActive(status: JobStatus | undefined): boolean {
  return status === "pending" || status === "running";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function statusBadge(status: JobStatus): { label: string; variant: BadgeProps["variant"] } {
  switch (status) {
    case "uploaded":
      return { label: "Awaiting mapping", variant: "neutral" };
    case "pending":
      return { label: "Queued", variant: "neutral" };
    case "running":
      return { label: "Running", variant: "primary" };
    case "completed":
      return { label: "Completed", variant: "success" };
    case "failed":
      return { label: "Failed", variant: "danger" };
    default:
      return { label: status, variant: "neutral" };
  }
}

function StatusBadge({ status }: { status: JobStatus }) {
  const { label, variant } = statusBadge(status);
  return (
    <Badge variant={variant}>
      {isActive(status) ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
      {label}
    </Badge>
  );
}

export function DataPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const importable = IMPORT_ENTITIES.filter((e) => hasPermission(active, `${e.key}.import`));
  const exportable = EXPORT_ENTITIES.filter((e) => hasPermission(active, `${e.key}.export`));

  if (importable.length === 0 && exportable.length === 0) {
    return (
      <div>
        <PageHeader title="Data" />
        <EmptyState icon={<DatabaseZap />} title="No access" description="Your role does not include permission to import or export data." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Data" description="Bring records in from CSV files and take your data with you." />
      <div className="grid gap-6">
        {importable.length > 0 ? <ImportSection entities={importable} /> : null}
        {exportable.length > 0 ? <ExportSection entities={exportable} /> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ import */

function ImportSection({ entities }: { entities: { key: ImportEntity; label: string }[] }) {
  const queryClient = useQueryClient();
  const [entity, setEntity] = React.useState<ImportEntity>(entities[0]?.key ?? "contacts");
  const [uploaded, setUploaded] = React.useState<ImportJob | null>(null);
  const [activeJobId, setActiveJobId] = React.useState<string | null>(null);

  const history = useQuery({
    queryKey: crmKeys.imports(entity),
    queryFn: () => listImports(entity),
  });

  const changeEntity = (value: string) => {
    if (!isImportEntity(value)) return;
    setEntity(value);
    setUploaded(null);
    setActiveJobId(null);
  };

  const reset = () => {
    setUploaded(null);
    setActiveJobId(null);
  };

  const entityLabel = entities.find((e) => e.key === entity)?.label ?? entity;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileUp className="size-4 text-primary" aria-hidden /> Import from CSV
        </CardTitle>
        <CardDescription>Upload a file, match its columns to fields, then run the import in the background.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor="import-entity">Record type</Label>
          <Select value={entity} onValueChange={changeEntity} disabled={Boolean(activeJobId) || Boolean(uploaded)}>
            <SelectTrigger id="import-entity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {entities.map((e) => (
                <SelectItem key={e.key} value={e.key}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {activeJobId ? (
          <ImportProgress
            entity={entity}
            jobId={activeJobId}
            onReset={reset}
            onCompleted={() => {
              void queryClient.invalidateQueries({ queryKey: ["crm", entity] });
              void queryClient.invalidateQueries({ queryKey: crmKeys.imports(entity) });
            }}
          />
        ) : uploaded ? (
          <ImportMapping
            entity={entity}
            job={uploaded}
            onCancel={() => setUploaded(null)}
            onStarted={(job) => {
              setUploaded(null);
              setActiveJobId(job.id);
              void queryClient.invalidateQueries({ queryKey: crmKeys.imports(entity) });
            }}
          />
        ) : (
          <ImportUpload entity={entity} entityLabel={entityLabel} onUploaded={setUploaded} />
        )}

        <div>
          <h3 className="mb-2 text-sm font-semibold">Your recent imports</h3>
          {history.isPending ? (
            <SkeletonRows rows={2} />
          ) : history.isError ? (
            <p className="text-sm text-danger">{errorMessage(history.error)}</p>
          ) : history.data.results.length === 0 ? (
            <p className="text-sm text-fg-muted">No {entityLabel.toLowerCase()} imports yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Rows</TableHead>
                  <TableHead className="hidden md:table-cell">Started</TableHead>
                  <TableHead className="w-20">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.data.results.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      <span className="block max-w-[14rem] truncate font-medium" title={job.original_filename}>
                        {job.original_filename || "Untitled"}
                      </span>
                      <span className="text-xs text-fg-subtle">{formatBytes(job.size_bytes)}</span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={job.status} />
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-fg-muted sm:table-cell">
                      {job.created_rows.toLocaleString()} created
                      {job.error_rows > 0 ? <span className="text-danger"> · {job.error_rows.toLocaleString()} errors</span> : null}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-fg-muted md:table-cell">{formatDateTime(job.started_at ?? job.created_at)}</TableCell>
                    <TableCell>
                      {job.status !== "uploaded" ? (
                        <Button variant="ghost" size="sm" onClick={() => setActiveJobId(job.id)}>
                          View
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function validateFile(file: File): string | null {
  if (!/\.csv$/i.test(file.name)) return "Choose a .csv file.";
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_FILE_BYTES) return `The file is ${formatBytes(file.size)}; the limit is 5 MB.`;
  return null;
}

function ImportUpload({ entity, entityLabel, onUploaded }: { entity: ImportEntity; entityLabel: string; onUploaded: (job: ImportJob) => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: (f: File) => uploadImport(entity, f),
    onSuccess: (job) => {
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      onUploaded(job);
    },
    onError: (err) => {
      if (isApiError(err) && err.isValidation) {
        const errors = err.fieldErrors();
        setFileError(errors.file ?? errors.non_field_errors ?? err.summary());
      } else {
        setFileError(errorMessage(err, "Upload failed."));
      }
    },
  });

  const pick = (candidate: File | undefined | null) => {
    if (!candidate) return;
    const problem = validateFile(candidate);
    setFileError(problem);
    setFile(problem ? null : candidate);
  };

  return (
    <div className="grid gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-8 text-center transition-colors",
          dragging ? "border-primary bg-primary-soft" : "border-border-strong bg-bg-subtle/50",
        )}
      >
        <FileSpreadsheet className="size-8 text-fg-subtle" aria-hidden />
        {file ? (
          <p className="text-sm">
            <span className="font-medium">{file.name}</span> <span className="text-fg-subtle">({formatBytes(file.size)})</span>
          </p>
        ) : (
          <p className="text-sm text-fg-muted">Drop a CSV file here, or choose one from your computer.</p>
        )}
        <Label htmlFor="import-file" className="cursor-pointer rounded-sm border border-border-strong bg-surface px-3 py-1.5 text-sm shadow-sm hover:bg-bg-subtle">
          {file ? "Choose a different file" : "Choose file"}
        </Label>
        <input
          ref={inputRef}
          id="import-file"
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          aria-describedby="import-file-help"
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <p id="import-file-help" className="text-xs text-fg-subtle">
          CSV only, UTF-8 encoded, up to 5 MB, {MAX_ROWS.toLocaleString()} rows and 60 columns. The first row must contain column headers.
        </p>
      </div>
      <FormError message={fileError} />
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => file && upload.mutate(file)} disabled={!file} loading={upload.isPending}>
          <FileUp /> Upload and map columns
        </Button>
        <span className="text-xs text-fg-subtle">Nothing is imported until you confirm the column mapping.</span>
      </div>
      <p className="text-xs text-fg-subtle">
        Importing {entityLabel.toLowerCase()}: rows that fail validation are skipped and reported with their row number; the rest are created.
      </p>
    </div>
  );
}

function sampleValues(job: ImportJob, header: string): string {
  const values = (job.preview ?? [])
    .map((row) => row[header])
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .slice(0, 3);
  return values.join(" · ");
}

function ImportMapping({
  entity,
  job,
  onCancel,
  onStarted,
}: {
  entity: ImportEntity;
  job: ImportJob;
  onCancel: () => void;
  onStarted: (job: ImportJob) => void;
}) {
  const targets = React.useMemo(() => Object.entries(job.targets ?? {}).sort((a, b) => a[1].localeCompare(b[1])), [job.targets]);
  const targetKeys = React.useMemo(() => new Set(targets.map(([key]) => key)), [targets]);
  const [mapping, setMapping] = React.useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const header of job.headers) {
      const suggested = job.mapping?.[header] ?? "";
      initial[header] = targetKeys.has(suggested) ? suggested : "";
    }
    return initial;
  });
  const [createCompanies, setCreateCompanies] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => startImport(entity, job.id, mapping, entity === "contacts" ? { create_companies: createCompanies } : undefined),
    onSuccess: onStarted,
    onError: (err) => {
      if (isApiError(err) && err.isValidation) {
        const errors = err.fieldErrors();
        setError(errors.mapping ?? errors.options ?? errors.non_field_errors ?? err.summary());
      } else {
        setError(errorMessage(err, "Could not start the import."));
      }
    },
  });

  const mappedCount = Object.values(mapping).filter(Boolean).length;
  const usedBy = React.useMemo(() => {
    const out = new Map<string, string[]>();
    for (const [header, target] of Object.entries(mapping)) {
      if (!target) continue;
      out.set(target, [...(out.get(target) ?? []), header]);
    }
    return out;
  }, [mapping]);
  const duplicates = [...usedBy.entries()].filter(([, headers]) => headers.length > 1);

  const submit = () => {
    if (mappedCount === 0) {
      setError("Map at least one column to a field.");
      return;
    }
    if (duplicates.length > 0) {
      const names = duplicates.map(([target]) => job.targets?.[target] ?? target).join(", ");
      setError(`Each field can receive only one column. Mapped more than once: ${names}.`);
      return;
    }
    setError(null);
    start.mutate();
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Map columns</h3>
          <p className="text-xs text-fg-muted">
            <span className="font-medium text-fg">{job.original_filename}</span> · {job.total_rows.toLocaleString()} rows · {job.headers.length} columns. Suggested matches are
            pre-selected.
          </p>
        </div>
        <Badge variant="neutral">
          {mappedCount} of {job.headers.length} mapped
        </Badge>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>CSV column</TableHead>
            <TableHead className="hidden md:table-cell">Sample values</TableHead>
            <TableHead className="w-64">Import into</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {job.headers.map((header, index) => {
            const value = mapping[header] ?? "";
            const duplicate = Boolean(value) && (usedBy.get(value)?.length ?? 0) > 1;
            const selectId = `import-map-${index}`;
            return (
              <TableRow key={`${header}-${index}`}>
                <TableCell>
                  <Label htmlFor={selectId} className="block max-w-[12rem] truncate font-mono text-xs" title={header}>
                    {header || `Column ${index + 1}`}
                  </Label>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <span className="block max-w-xs truncate text-xs text-fg-muted" title={sampleValues(job, header)}>
                    {sampleValues(job, header) || <span className="text-fg-subtle">(empty)</span>}
                  </span>
                </TableCell>
                <TableCell>
                  <Select value={value || SKIP} onValueChange={(next) => setMapping((prev) => ({ ...prev, [header]: next === SKIP ? "" : next }))}>
                    <SelectTrigger id={selectId} aria-invalid={duplicate || undefined} className={cn(!value && "text-fg-subtle")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SKIP}>Skip this column</SelectItem>
                      {targets.map(([key, label]) => (
                        <SelectItem key={key} value={key}>
                          {label}
                          {key.startsWith("custom.") ? <span className="ml-1 text-xs text-fg-subtle">(custom)</span> : null}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {entity === "contacts" ? (
        <div className="flex items-center gap-2">
          <Switch id="import-create-companies" checked={createCompanies} onCheckedChange={setCreateCompanies} />
          <Label htmlFor="import-create-companies" className="cursor-pointer">
            Create companies that don&apos;t exist yet
          </Label>
          <span className="text-xs text-fg-subtle">(matched by name from the mapped company column)</span>
        </div>
      ) : null}

      <FormError message={error} />

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={start.isPending}>
          Cancel
        </Button>
        <Button onClick={submit} loading={start.isPending}>
          Start import
        </Button>
      </div>
    </div>
  );
}

function ImportProgress({
  entity,
  jobId,
  onReset,
  onCompleted,
}: {
  entity: ImportEntity;
  jobId: string;
  onReset: () => void;
  onCompleted: () => void;
}) {
  const job = useQuery({
    queryKey: crmKeys.importJob(entity, jobId),
    queryFn: () => getImport(entity, jobId),
    refetchInterval: (query) => (isActive(query.state.data?.status) ? POLL_MS : false),
  });
  const status = job.data?.status;
  const notified = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (status === "completed" && notified.current !== jobId) {
      notified.current = jobId;
      onCompleted();
    }
  }, [status, jobId, onCompleted]);

  if (job.isPending) return <SkeletonRows rows={2} />;
  if (job.isError) {
    return (
      <EmptyState
        title="Could not load this import"
        description={errorMessage(job.error)}
        action={
          <Button variant="secondary" onClick={onReset}>
            Back
          </Button>
        }
      />
    );
  }

  const data = job.data;
  const total = Math.max(data.total_rows, data.processed_rows, 0);
  const percent = total > 0 ? Math.min(100, Math.round((data.processed_rows / total) * 100)) : data.status === "completed" ? 100 : 0;
  const running = isActive(data.status);

  return (
    <div className="grid gap-4 rounded-md border border-border bg-bg-subtle/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            {data.status === "completed" ? (
              <CheckCircle2 className="size-4 text-success" aria-hidden />
            ) : data.status === "failed" ? (
              <XCircle className="size-4 text-danger" aria-hidden />
            ) : (
              <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
            )}
            <span className="truncate">{data.original_filename || "Import"}</span>
          </h3>
          <p className="text-xs text-fg-muted">
            {running ? "Running in the background; this page updates every few seconds." : data.finished_at ? `Finished ${formatDateTime(data.finished_at)}` : formatDateTime(data.created_at)}
          </p>
        </div>
        <StatusBadge status={data.status} />
      </div>

      <div className="grid gap-1" role="status" aria-live="polite">
        <div className="flex justify-between text-xs text-fg-muted">
          <span>
            {data.processed_rows.toLocaleString()} of {total.toLocaleString()} rows processed
          </span>
          <span>{percent}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-border" aria-hidden>
          <div className={cn("h-full rounded-full transition-[width]", data.status === "failed" ? "bg-danger" : "bg-primary")} style={{ width: `${percent}%` }} />
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-fg-subtle">Created</dt>
          <dd className="font-semibold text-success">{data.created_rows.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-subtle">Errors</dt>
          <dd className={cn("font-semibold", data.error_rows > 0 ? "text-danger" : "")}>{data.error_rows.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-subtle">Total rows</dt>
          <dd className="font-semibold">{data.total_rows.toLocaleString()}</dd>
        </div>
      </dl>

      {data.status === "failed" && data.error_message ? <FormError message={data.error_message} /> : null}

      {data.errors.length > 0 ? (
        <details open={data.status !== "running"}>
          <summary className="cursor-pointer text-sm font-medium">
            Row errors ({data.errors.length.toLocaleString()}
            {data.error_rows > data.errors.length ? ` of ${data.error_rows.toLocaleString()} shown` : ""})
          </summary>
          <div className="mt-2 max-h-72 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Row</TableHead>
                  <TableHead className="w-40">Field</TableHead>
                  <TableHead>Problem</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.errors.flatMap((rowError) =>
                  rowError.errors.map((e, i) => (
                    <TableRow key={`${rowError.row}-${e.field}-${i}`}>
                      <TableCell className="font-mono text-xs">{rowError.row}</TableCell>
                      <TableCell className="font-mono text-xs">{e.field}</TableCell>
                      <TableCell className="text-xs">{e.message}</TableCell>
                    </TableRow>
                  )),
                )}
              </TableBody>
            </Table>
          </div>
        </details>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {running ? (
          <Button variant="secondary" size="sm" onClick={() => job.refetch()} loading={job.isFetching}>
            <RefreshCw /> Refresh now
          </Button>
        ) : null}
        <Button variant={running ? "ghost" : "secondary"} size="sm" onClick={onReset}>
          {running ? "Back" : "Import another file"}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ export */

function ExportSection({ entities }: { entities: { key: ExportEntity; label: string }[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const [entity, setEntity] = React.useState<ExportEntity>(entities[0]?.key ?? "contacts");

  const exports = useQuery({
    queryKey: crmKeys.exports(entity),
    queryFn: () => listExports(entity),
    refetchInterval: (query) => (query.state.data?.results.some((job) => isActive(job.status)) ? POLL_MS : false),
  });

  const request = useMutation({
    mutationFn: () => runSensitive(() => createExport(entity)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: crmKeys.exports(entity) });
      toast({ tone: "success", title: "Export requested", description: "It will appear below as soon as the file is ready." });
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      toast({ tone: "error", title: "Could not request export", description: errorMessage(err) });
    },
  });

  const entityLabel = entities.find((e) => e.key === entity)?.label ?? entity;
  const now = Date.now();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="size-4 text-primary" aria-hidden /> Export to CSV
        </CardTitle>
        <CardDescription>Exports include every record you can see, with custom fields and tags. Files are kept for 24 hours.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grid gap-1.5 sm:w-64">
            <Label htmlFor="export-entity">Record type</Label>
            <Select value={entity} onValueChange={(v) => isExportEntity(v) && setEntity(v)}>
              <SelectTrigger id="export-entity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {entities.map((e) => (
                  <SelectItem key={e.key} value={e.key}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => request.mutate()} loading={request.isPending}>
            <Download /> Request export
          </Button>
        </div>
        <ul className="grid gap-1 text-xs text-fg-subtle">
          <li>List filters are not applied yet: an export contains all {entityLabel.toLowerCase()} in your scope.</li>
          <li className="flex items-start gap-1.5">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>You will be asked to confirm your password. Cells that look like spreadsheet formulas are neutralised so the file is safe to open.</span>
          </li>
        </ul>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Export jobs</h3>
          {exports.isPending ? (
            <SkeletonRows rows={2} />
          ) : exports.isError ? (
            <p className="text-sm text-danger">{errorMessage(exports.error)}</p>
          ) : exports.data.results.length === 0 ? (
            <p className="text-sm text-fg-muted">No {entityLabel.toLowerCase()} exports yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Requested</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Rows</TableHead>
                  <TableHead className="hidden md:table-cell">Size</TableHead>
                  <TableHead className="hidden md:table-cell">Expires</TableHead>
                  <TableHead className="w-28">
                    <span className="sr-only">Download</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {exports.data.results.map((job) => (
                  <ExportRow key={job.id} entity={entity} job={job} now={now} />
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ExportRow({ entity, job, now }: { entity: ExportEntity; job: ExportJob; now: number }) {
  const expiresAt = job.expires_at ? new Date(job.expires_at).getTime() : null;
  const expired = expiresAt !== null && !Number.isNaN(expiresAt) && expiresAt <= now;
  const ready = job.status === "completed" && !expired;
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">
        <span className="block">{formatDateTime(job.created_at)}</span>
        {job.requested_by ? <span className="text-xs text-fg-subtle">{job.requested_by.display_name}</span> : null}
      </TableCell>
      <TableCell>
        <StatusBadge status={job.status} />
        {job.status === "failed" && job.error_message ? <p className="mt-1 max-w-xs text-xs text-danger">{job.error_message}</p> : null}
      </TableCell>
      <TableCell className="hidden text-fg-muted sm:table-cell">{job.status === "completed" ? job.row_count.toLocaleString() : "—"}</TableCell>
      <TableCell className="hidden text-fg-muted md:table-cell">{job.status === "completed" ? formatBytes(job.size_bytes) : "—"}</TableCell>
      <TableCell className="hidden whitespace-nowrap text-fg-muted md:table-cell">
        {expired ? <span className="text-fg-subtle">Expired</span> : job.expires_at ? formatDateTime(job.expires_at) : "—"}
      </TableCell>
      <TableCell>
        {ready ? (
          <Button asChild variant="secondary" size="sm">
            <a href={exportDownloadUrl(entity, job.id)} download>
              <Download /> Download
            </a>
          </Button>
        ) : expired ? (
          <span className="text-xs text-fg-subtle">No longer available</span>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
