# Input preferences implementation plan

> Execute inline with superpowers:executing-plans; keep the existing checkout and use a codex branch. The user has authorized autonomous planning and implementation without approval pauses.

**Goal:** Add opt-in per-device scroll reversal and Alt/Win swapping for shared input.

**Architecture:** Persist booleans on TrustedPeer, copy preferences into each sending Control session, transform validated events before enqueuing. Reuse peerSettings IPC and existing switches; native protocol stays unchanged.

**Tech Stack:** TypeScript, Electron, React, Node integration tests, Playwright Electron smoke.

## 1. Storage and input regression tests

- [x] Add `tests/input-preferences.case.ts` using two real HTTPS services paired with Extensions. Assert new peers default false; `setPeer(fp, { invertScroll: true, swapAltWin: true })` persists and Extensions reloading restores preferences. Remove fields from trust.json to test legacy migration. Reject nonboolean values without partially applying the patch.
- [x] Through `Control.start` / `push` and receiver `input`, verify baseline input then enable independent and combined options. Assert scroll {dx:2,dy:-3} → {-2,3}; keys 164↔91 and 165↔92 both down/up; other keys/buttons/moves unchanged. Change options while held and assert release uses session snapshot; next session uses new values. Receiver settings must not affect the sending direction.
- [x] Run `bun test` and verify failures are assertions for missing defaults/mapping.

## 2. Implement settings and session mapping

- [x] Extend TrustedPeer fields and peerSettings Pick type; add false defaults at both pairing paths and strict `=== true` legacy normalization at load.
- [x] Validate all setPeer values before Object.assign and persistence; extend main IPC whitelist with both names.
- [x] Store `{ invertScroll, swapAltWin }` in sending Session on start. Transform in `push` after validInput; map four modifier codes, negate nonzero scroll components, preserve order and avoid mutating source event objects.
- [x] Run `bun test` and `bun run typecheck`.

## 3. UI and release

- [x] Add an accessible settings group per device with two independent existing Toggle components. Include mapping and next-session guidance.
- [x] Extend scripts/smoke.ts to click switches, assert default/true/false snapshots, and reject malformed input via IPC. Run `bun run build && bun run smoke`; inspect saved connect screenshot.
- [x] Update README and release notes, bump to 0.1.3, set release workflow default. Run formatting, typecheck, full tests, build, Mac signature validation and package smoke as appropriate.
- [ ] Commit and push; use existing cloud release workflow to build Mac and Windows, wait for native self-tests and publish success; verify assets before delivering links.
