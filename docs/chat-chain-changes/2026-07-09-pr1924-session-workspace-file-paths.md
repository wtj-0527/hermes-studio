---
date: 2026-07-09
pr: 1924
feature: Session workspace file paths
impact: Session workspace file APIs now accept legacy `workspace/...` paths and normalize responses to workspace-relative paths, avoiding duplicated workspace segments while leaving generic file APIs unchanged.
---

# Session workspace file path normalization

Session workspace file requests may come from older callers or provider-returned paths that include the workspace directory prefix, such as `workspace/project/file.md`. The session workspace API now strips that prefix before resolving paths against the session workspace root.

This keeps file panel navigation compatible with legacy `workspace/...` values without changing generic `/api/hermes/files/*` behavior.
