---
date: 2026-07-11
pr: pending
feature: Maximum reasoning effort
impact: Chat and scoped coding-agent runs can select and forward GPT-5.6 reasoning effort `max` without conflating it with Codex Ultra multi-agent mode.
---

The per-session Chat selector now exposes `max`, localized labels distinguish it from `xhigh`, and Codex/Claude proxy adapters plus the scoped Codex model catalog preserve the value end to end.
