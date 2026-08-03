---
date: 2026-08-03
pr: pending
feature: Provider-neutral managed Browser Runtime
impact: BrowserPanel, Agent browser tools, and Desktop browser controls now share one provider-neutral control plane, while Web can use an authenticated private runtime gateway without exposing runtime endpoints to the client.
---

The Browser panel is no longer tied to one platform implementation. A provider
registry selects the available browser provider per authenticated user and
Hermes profile. Desktop keeps its local Electron provider; Web can select a
managed remote provider through the same tab, navigation, snapshot,
interaction, screenshot, console, takeover, and release semantics.

The managed provider uses the generic `HERMES_BROWSER_RUNTIME_URL` and
`HERMES_BROWSER_RUNTIME_TOKEN_FILE` contract. The private runtime gateway
returns the CDP and live-view WebSocket endpoints for each exact session;
Hermes Studio validates those endpoints, authenticates HTTP and WebSocket
traffic, proxies live view through one-time same-origin capabilities, and
fences owner, profile, operation, takeover, deactivation, and release state.
The source contract does not select or package a particular browser vendor.

Browser address submission trims input and creates an active tab when none
exists. Bare domains such as `baidu.com` are normalized by the runtime adapter
to HTTPS. Profile changes, logout, authority mutation, shutdown, and provider
switches deactivate the previous owner before admitting later work.
