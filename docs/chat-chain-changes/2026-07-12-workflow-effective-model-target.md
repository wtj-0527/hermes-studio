---
date: 2026-07-12
pr: pending
feature: Workflow effective model targets and authoring interactions
impact: Workflow runs resolve inherited profile-default model tuples before persistence and dispatch, preserve fail-closed reasoning validation, open edge policy editing on left click, and create a connected Hermes Agent node when an output connection ends on empty canvas.
---

# Workflow effective model target preflight

Workflow runs now resolve nodes that omit `provider`, `model`, and `apiMode` to the selected profile's authoritative visible default model tuple before run persistence and backend dispatch.

- Explicit and partial node targets remain fail-closed against the authoritative available-model list.
- Explicit reasoning effort is validated against capability metadata for the resolved tuple; it is never silently downgraded or removed.
- The resolved tuple is frozen into new run snapshots so later profile-default changes do not change an accepted run.
- Legacy reruns with empty model tuples resolve the same profile default before mutating run state or dispatching chat work.
