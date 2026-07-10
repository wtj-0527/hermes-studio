---
date: 2026-07-10
pr: 2011
feature: Hide zero-line workspace diffs in current and historical sessions
impact: Uses additions=0 and deletions=0 as the sole per-file suppression rule, replacing filename-specific SQLite sidecar filtering; startup cleanup removes historical zero-line rows and recalculates affected cards.
---
