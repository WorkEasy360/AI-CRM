# ADR-0009 — AI as an untrusted subsystem behind a typed, permission-gated tool layer with human-confirmed actions

**Status:** Proposed

## Context
The Copilot must answer questions over CRM data and help with actions, without any path by which the model, or content it reads, can access other tenants' data, bypass permissions, or change records unsupervised.

## Decision
The model interacts with the CRM only through a fixed catalogue of read-only tools whose handlers run as the human actor (tenant context + `authz.scope()`), accept strictly validated arguments, and never take an organization argument. No SQL, no code execution, no write tools. Anything that changes state becomes an `AIProposedAction` that the user confirms through the normal authenticated API; the executor is the same service the UI uses. Retrieved content is delimited, escaped, labelled untrusted and size-capped; outputs are validated before display. Providers are accessed through an adapter; usage is metered and budgeted; every tool call and proposal is audited. Scores are labelled "Rules-Based" until a registered, evaluated and approved predictive model exists.

## Consequences
- The security boundary is the tool layer, which is ordinary, testable Django code.
- Some questions cannot be answered (anything outside the metric and tool catalogue); the catalogue grows deliberately.
- Human confirmation adds a step to AI-initiated changes; this is intentional.
- Provider switching is a configuration change plus an adapter implementation.
