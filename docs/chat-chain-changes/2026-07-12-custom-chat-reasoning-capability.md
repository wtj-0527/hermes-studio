---
date: 2026-07-12
pr: draft-6
feature: custom-chat-reasoning-capability
impact: chat-runtime
---

# Custom chat-completions reasoning capability and exact wire override

- Fix Hermes Studio preflight for standard legacy `custom_providers` entries that do not embed Studio-specific `supported_reasoning_levels` metadata.
- For Bearer-authenticated custom `chat_completions` targets (`api_key` or selected-profile `key_env`), probe the configured provider model catalog using the same `/models` URL convention and require exact model-level `capabilities.reasoning: true`; catalog failure, missing model, unsupported auth shape, or absent/false capability remains fail-closed. Selected-profile dotenv values follow Studio's existing quoted/unquoted parsing, and v12 providers resolve by the same visible name key used by the Studio model catalog while retaining exact raw dict-key compatibility.
- Preserve explicit profile-config level lists as the stricter authority when present.
- Apply the canonical per-run effort to both Hermes `reasoning_config` and the official `request_overrides.reasoning_effort` wire path for `chat_completions`, then restore both agent fields after normal or exceptional completion, deleting temporary attributes that were originally absent.
- Coalesce concurrent probes and cache only positive capability results for 60 seconds, scoped by profile/provider/catalog URL/model/API mode and an in-process HMAC credential fingerprint; plaintext credentials and negative results are never cached.
- Do not clamp, downgrade, persist globally, or inject the top-level wire override into other API modes.
- Regression coverage includes live legacy-provider validation, missing capability rejection, exact `max` propagation, state restoration, and bridge facade patch synchronization.
