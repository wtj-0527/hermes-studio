---
date: 2026-07-12
pr: pending
feature: Chat inherited reasoning model target
impact: Chat socket and internal runAndWait requests with an explicit reasoning effort and an omitted model tuple now resolve the selected profile's authoritative effective default tuple before capability validation and dispatch; partial tuples remain fail-closed.
---

A field-installed test package exposed that Workflow preflight resolution did not cover ordinary Chat messages. A Chat request could carry a session-level `reasoning_effort` while omitting `provider`, `model`, and `apiMode`, causing capability validation to report an empty `//` identity before backend dispatch. Both Chat entry paths now resolve only the all-empty tuple to the profile effective model reference, write that tuple into the current run request, and validate the same execution identity that reaches the backend. Explicit partial or unavailable targets are not silently completed.
