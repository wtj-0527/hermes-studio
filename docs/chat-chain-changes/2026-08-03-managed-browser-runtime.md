---
date: 2026-08-03
pr: pending
feature: Provider-neutral managed Browser Runtime
impact: BrowserPanel, Agent browser tools, and Desktop browser controls share one provider-neutral control plane. Web can use a private Remote Session API plus CDP without exposing runtime endpoints or credentials to the client.
---

The Browser panel is no longer tied to one platform implementation. A provider
registry selects the available browser provider per authenticated user and
Hermes profile. Desktop keeps its local Electron provider; Web can select a
managed remote provider through the same tab, navigation, snapshot,
interaction, screenshot, console, takeover, and release semantics.

The managed provider uses the generic `HERMES_BROWSER_RUNTIME_URL` and optional
`HERMES_BROWSER_RUNTIME_TOKEN_FILE` contract. Studio creates an exact remote
session with `POST /v1/sessions`, sends only `sessionId` plus the optional
Studio egress `proxyUrl`, and consumes the returned `id` and `websocketUrl`.
Owner and profile authority stay inside the Studio control plane.

Studio validates and DNS-pins the private Runtime authority, connects to CDP,
and renders the selected page with its own page-scoped CDP screencast. Viewer
input is mapped only to bounded mouse, key, and text CDP commands after user
takeover; arbitrary CDP commands are never accepted from the client. One-time
same-origin capabilities are fenced to owner, profile, Runtime session,
incarnation, page, and generation. The source contract does not select or
package a particular browser vendor.

Browser address submission trims input and creates an active tab when none
exists. Bare domains such as `baidu.com` are normalized by the runtime adapter
to HTTPS. Profile changes, logout, authority mutation, shutdown, and provider
switches deactivate the previous owner before admitting later work.
