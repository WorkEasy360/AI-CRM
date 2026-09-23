"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listCustomFields } from "@/lib/api/crm";
import type { EntityType } from "@/lib/api/crm-types";
import { crmKeys } from "@/lib/crm/keys";

/**
 * Custom-field definitions, kept apart from `components/crm/custom-fields-form.tsx` so that a list
 * page can warm a record form without importing the form's inputs: that module pulls in the Select,
 * Switch and Textarea primitives, and importing the hook from it put all of them back into every
 * list page's own bundle - exactly the code lazy-loading the dialog exists to keep out.
 */
const customFieldsQuery = (entity: EntityType) => ({
  queryKey: crmKeys.customFields(entity),
  queryFn: () => listCustomFields(entity),
  staleTime: 5 * 60_000,
});

/** Active custom-field definitions for an entity type (cached 5 min). */
export function useCustomFields(entity: EntityType) {
  const query = useQuery(customFieldsQuery(entity));
  return { definitions: query.data?.results ?? [], isPending: query.isPending };
}

/**
 * Warms a record form before it is opened: its lazily-imported chunk and the custom-field
 * definitions it renders.
 *
 * List pages used to mount their form dialog permanently with `open={false}`. `next/dynamic` starts
 * loading on mount regardless of props, so every visit to Contacts, Companies, Products or Pipeline
 * downloaded the form chunk and, once it arrived, fired `GET /api/v1/custom-fields/` - a request that
 * could only start after the chunk had loaded, which is why it trailed the list request rather than
 * running beside it. Mounting the dialog only while it is open removes both from the route's initial
 * load; calling this on the create button's hover/focus puts them back ahead of the click, so opening
 * the form stays instant for anyone who actually opens it.
 */
export function useWarmRecordForm(entity: EntityType, importForm: () => Promise<unknown>): () => void {
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    void importForm();
    void queryClient.prefetchQuery(customFieldsQuery(entity));
  }, [entity, importForm, queryClient]);
}
