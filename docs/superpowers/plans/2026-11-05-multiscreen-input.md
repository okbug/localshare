# Multi-screen input and Mac capture implementation plan

> Execute using superpowers:executing-plans with independent native domains delegated under superpowers:dispatching-parallel-agents. User approved implementation, testing and release; no approval pauses.

**Goal:** Mac capture centers the local pointer and restores its original position; Windows input spans its real monitor topology with correct return portals, layout preview and optional entry display.

**Architecture:** Keep geometry in a platform-neutral C++ header exercised on macOS and Windows. Windows helper owns enumeration, DPI, movement, hotplug safety and emits validated layout metadata. Existing paired HTTPS transport shares layout metadata and session-scoped optional display ID. React renders a read-only layout preview and settings; never changes Windows display settings. Native processes retain watchdog and emergency recovery.

**Tech Stack:** Objective-C/CoreGraphics, C++17/Win32, TypeScript/Electron/React, Node integration tests, native self-tests and CI packaging.

## Native/bridge contract

- Windows helper `--layout` outputs one JSON object: `{version:1,platform:"windows",entrySelection:true,displays:[{id:"DISPLAY1",name:"DISPLAY1",x:0,y:0,width:1920,height:1080,primary:true}]}`. IDs ASCII `[A-Za-z0-9_.:-]{1,80}`, max 32 distinct rectangles, physical pixel coordinates including negatives. Primary/duplicate handling in enumeration. `--check`, `ready` and runtime `{type:"layout",...layout}` may also include these fields.
- `receive` command gains optional `display` with safe ASCII ID; absent/empty uses the exterior envelope on the arrival side (`side:right` means entering left). Explicit display uses only exposed portions of that display edge. Reject a missing/fully blocked display with an error; never silently enter the wrong screen.
- After any topology change, helper releases active input and emits `{type:"layout",...layout}` and `{type:"emergency"}` if a session was active. Re-enumerate before capture/receive; use hidden top-level window notifications plus a low-frequency check. Failed enumeration ends active control and reports an error.
- Existing input event protocol remains. Native protocol version advances to 3 on both platforms and bridge; obsolete helper binaries fail readiness.
- TypeScript `DisplayLayout` matches the helper schema. Paired `/displays` returns validated metadata. `TrustedPeer.entryDisplay?: string` is sender-local; `""`/missing means auto. Explicit selection requires successful layout capability validation before capture and a selected available display. `/control/start` includes optional `display` only for explicit selection; validate ASCII ID and propagate to InputAdapter.receive. Unknown legacy endpoints show unsupported; automatic mode remains compatible at the network layer.

## Tasks

- [x] Mac: write failing lifecycle tests with a native in-memory OS seam; center separate anchor from exact restore position, mark/ignore warp events, prevent feedback, restore on return/stop/error/watchdog. Test failure cleanup, repeat release and delta preservation without controlling the user's live session. Compile and run native self-tests.
- [x] Windows: write failing C++ geometry cases (negative origin, all directions, exposed portals, holes, large steps, clone rectangles, normalization). Implement geometry plus EnumDisplayMonitors/GetMonitorInfo, PMv2 DPI, VIRTUALDESK injection, valid monitor capture anchor, entry/return portals, refresh notification/timer and --layout. Run portable geometry on Mac and MSVC in CI.
- [x] Core: add layout validation, authenticated discovery, bounded session display selection, persistence/legacy defaults. Real HTTPS tests cover authorization, malformed metadata, unsupported peers, session forwarding and target validation before capture.
- [x] Bridge/UI: validate helper layout, expose refresh through fixed IPC, display paired Windows topology with main-screen marker, safe edge choices and automatic reset on unplug. Add smoke tests for layout rendering/selection/settings using an explicit synthetic test fixture and test IPC; retain real two-app transfer/pairing smoke.
- [x] Review integration for lifecycle races, non-recursive release, stale geometry, edge mapping and held modifier safety. Run typecheck, formatting, all integration and native tests, built Mac smoke, Mac ZIP verification; cross-compile Windows and then run real Windows CI.
- [ ] Update README/release notes and version 0.1.4, push and publish via existing cloud workflow. Verify both platform builds/native tests and public download assets. Clearly distinguish automated/in-memory tests from physical Mac/Windows multi-monitor validation.
