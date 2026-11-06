import type { Pipeline } from "@/lib/api/crm-types";

/** Team pipelines in order, each followed by its sub-pipelines. */
export function orderFamilies(pipelines: Pipeline[]): Pipeline[] {
  const roots = pipelines.filter((p) => !p.parent_id || !pipelines.some((q) => q.id === p.parent_id));
  return roots.flatMap((root) => [root, ...pipelines.filter((p) => p.parent_id === root.id)]);
}
