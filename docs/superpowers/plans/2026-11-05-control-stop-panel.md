# Floating stop panel implementation plan

> Execute inline under planning/TDD/verification skills; delegate independent clipboard/core domain under superpowers:dispatching-parallel-agents. User authorizes autonomous implementation without approval pauses.

**Goal:** Show fixed always-on-top stop panels and stop keyboard, mouse and the current peer's text sharing through one button or emergency shortcut.

**Architecture:** BrowserWindow panel with dedicated restricted preload/IPC. Core session-bound stopSharing revokes per-peer clipboard permission before draining queued OS writes and notifying peer, with immutable clipboard delivery leases. Preserve normal portal return and other peer grants; no native cursor pass-through or screen capture.

**Tech stack:** Electron, TypeScript/React, Bun+Node HTTPS integration, Playwright Electron smoke.

- [x] Core/clipboard: failing race and authorization tests, then implement stopSharing(expectedId?), capabilities.stopSharing, stopClipboard handling, per-peer/global clipboard lease and send aborts; add pure ClipboardSync queue backend, flush and stopped checks. Preserve backwards event callbacks and independent sharing flags.
- [x] Shared/UI: expose control.id and restricted ControlPanelAPI; add small React ControlPanel view, dedicated preload and bundled entry; panel settings are fixed top-right workArea with showInactive. Unit-check geometry on negative origins.
- [x] Main integration: panel lifecycle listens to hand control sessions; snapshots omit credentials; expected session ID fences stop; dedicated IPC rejects main/foreign frames and all other actions. Hotkey/native emergency/tray/main stop invoke stopSharing; default native return remains stop().
- [x] Test actual Electron panel with fake input/state to avoid live cursor capture: visible on sender/receiver, click stops linked peer, source guidance, frame access denial, hidden main window unaffected, stale session ignored, close/load failure fail closed.
- [ ] Full integration/typecheck/format/native tests, built Mac smoke and seal validation. Update README/notes/version0.1.6, publish Windows x64 and Mac arm64 through CI; verify assets and physical-test limits.
