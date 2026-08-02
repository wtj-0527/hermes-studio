---
date: 2026-08-02
pr: pending
feature: Add platform-specific BrowserProvider runtimes
impact: Desktop chat and group chat retain Electron WebContentsView browsing, while authenticated Web sessions use a Studio-managed Steel Browser runtime through the same BrowserPanel and Browser MCP semantics.
---

The shared chat browser panel now selects an `ElectronBrowserProvider` on Desktop
and a `SteelBrowserProvider` on Web. Web browser sessions, tabs, live view, and
Agent operations are bound to the authenticated user and active Hermes profile.

Steel remains an internal loopback runtime. The browser does not receive Steel,
CDP, or cast endpoints, and the Studio bearer token is never placed in a live-view
URL. Live-view WebSocket upgrades require an exact trusted `HERMES_PUBLIC_ORIGIN`;
packagers must bind it to the platform-assigned public application origin (for
LazyCat, `https://${LAZYCAT_APP_DOMAIN}`) rather than deriving trust from request
`Host` or forwarded headers. When the embedded runtime is unavailable, browser
operations fail closed without disabling chat or Workflow execution.

The embedded Steel runtime is packaged from an API-only lockfile at
`docker/steel-runtime-package-lock.json`; standalone Steel UI/Repl dependencies
and disabled DuckDB log persistence are not shipped. Container builds run
`npm audit --omit=dev --registry=https://registry.npmjs.org --audit-level=low`
as a fail-closed gate. The corresponding CycloneDX 1.6 SBOM is committed at
`docs/security/steel-runtime.cdx.json`.
