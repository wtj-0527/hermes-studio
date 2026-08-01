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
URL. When the embedded runtime is unavailable, browser operations fail closed
without disabling chat or Workflow execution.
