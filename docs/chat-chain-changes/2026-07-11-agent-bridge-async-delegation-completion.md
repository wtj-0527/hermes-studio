---
date: 2026-07-11
commit: uncommitted
feature: Agent Bridge async delegation completion delivery
impact: Completed background delegate results re-enter only their originating idle Studio session as a formatter-backed follow-up turn.
---

Profile workers expose their process-memory completion queues through explicit
`async_completions_list` and `async_completion_ack` operations. Studio's
`ChatRunSocket` polls loaded profiles on a controlled interval and, only when the
originating session is idle, routes each completion by `session_key` through the
existing chat-run path so database state and WebSocket updates remain consistent.
Worker-side pending and acknowledgement handling provides retry and deduplication;
Studio keeps only an in-flight guard, and closing `ChatRunSocket` clears the poll
timer.

At-least-once delivery is limited to the lifetime of the profile worker: the Hermes completion queue is process-memory only, so restarting the worker can lose completions that have not yet been delivered. Studio keeps only an in-flight concurrency guard and relies on the worker's pending queue plus acknowledgement for retry and deduplication.
