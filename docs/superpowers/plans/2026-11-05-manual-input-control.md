# Manual LAN input control implementation plan

> Execute inline using planning, TDD, verification skills; delegate independent macOS and Windows native domains under superpowers:dispatching-parallel-agents. User requests autonomous implementation and no screen transmission.

**Goal:** Start explicit keyboard/mouse control from a paired device card without crossing a screen edge.

**Architecture:** Add a session interaction mode to existing authenticated control protocol. Verify capability before capture, preserve target cursor and disable portal return in manual mode; keep the existing global emergency release and exclusive session. Native protocol4 ensures matching helper behavior. Existing file and clipboard modules stay independent.

**Tech Stack:** Electron+Bun, TypeScript/React, Objective-C, C++17, native self-tests and real HTTPS integration.

- [x] Add failing integration cases in tests/manual-control.case.ts: capability query, manual receive parameters, no entry-display preflight, default edge behavior, invalid request rejection, old-peer error before capture, mutual exclusion, input and release.
- [x] Implement interaction/capability in src/core/control.ts, snapshot and DesktopAPI types in src/shared/types.ts, preload and main controlDevice IPC; preserve cancellation identity guards and input preferences.
- [x] Mac native: receive manual flag, preserve target point, disable edge return only for manual; extend in-memory lifecycle tests, bump protocol4. No live desktop injection.
- [x] Windows native: pure receive policy and regression tests for manual preserve/empty return portals; integrate with native command and retain all geometry checks, bump protocol4. Verify cross-build.
- [x] Add per-peer start button, mode/target status and stop guidance; extend isolated Electron UI smoke for authorization gating and exact IPC. Preserve source cursor until the user explicitly clicks start; real capture is never auto-started by tests.
- [x] Run appropriate full tests, typecheck/format, native self-tests/cross-build, packed Mac smoke and ZIP seal verification. Update README/notes/version0.1.5, commit/push and publish via existing cloud pipeline; verify artifacts and record physical-test limits. Published run:42016274057; app build commit:7d1875b. Later source fixes cover release-list lag and Intel ABI compilation, without changing the shipped ARM/Windows feature scope.
