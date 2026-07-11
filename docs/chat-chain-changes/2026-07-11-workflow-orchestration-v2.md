---
date: 2026-07-11
pr: pending
feature: Workflow Orchestration v2
impact: Workflow Agent runs gain canonical reasoning capability validation, bounded feedback loops with fresh per-iteration sessions, current-path joins, total timeout and execution-budget controls, append-only evidence, and definition-only portable JSON import/export without widening existing Chat or coding-agent execution paths.
---

The Workflow execution chain now carries explicit reasoning effort through Hermes and scoped Codex/Claude requests, rejects unknown or unsupported capabilities before side effects, and routes workflow-scoped coding-agent cancellation to its owning runner. V2 feedback-loop runs use a separate scheduler while loop-free DAG runs retain the v1 path. Export/import remains definition-only and confirmed imports create inactive Workflows without auto-running.
