---
date: 2026-07-18
pr: 15
title: Workflow Hermes runtime execution policy
feature: Per-node Hermes Workflow runtime capability policy
impact: Prevents Skill, tool, memory, and context widening across initial execution and final context accounting
issue: https://github.com/wtj-0527/hermes-studio/issues/14
---

## Touched chain

- Workflow node normalization, persistence, frozen run snapshots, and both schedulers
- Chat-run queue propagation and initial/final context estimation
- Agent Bridge client/server/facade and Python session creation

## Behavior impact

Hermes Workflow nodes can persist an explicit `executionPolicy` and enforce exact runtime tool/context limits. Empty allowlists remain deny-all; `allowedTools` only intersects assembled tools; memory/context-file loading can be skipped; idle sessions are recreated when policy identity changes; running sessions reject policy changes. The same policy remains attached through initial estimation, chat execution, and success/error final context refresh so the session cannot widen after a run. Context estimates and session status expose the normalized policy identity for live lifecycle auditing, and fixed-context caches are keyed by that identity. Cache events that omit policy metadata are treated as uncacheable instead of inheriting an older identity.

Ordinary chat and Workflow nodes without an explicit policy continue to use profile defaults. Policy use on non-Hermes Workflow agents fails closed.
