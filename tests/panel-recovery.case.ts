import { test } from "node:test";
import assert from "node:assert/strict";
import { PanelRecoveryView } from "../src/shared/panel-recovery";
import type { ControlPanelState } from "../src/shared/types";
const shared: ControlPanelState = {
  sessionId: "session-one",
  peer: "Windows",
  direction: "sending",
  clipboard: true,
  shortcut: "Control+Option+Esc",
};
test("recovery panel remains after logical stop until input restoration is confirmed", () => {
  const view = new PanelRecoveryView(() => ({
    ...shared,
    sessionId: "fallback",
  }));
  assert.equal(view.select(shared, {})?.phase, "sharing");
  assert.equal(
    view.select(null, { recovering: true })?.sessionId,
    shared.sessionId,
  );
  assert.equal(view.select(null, { recovering: true })?.phase, "recovering");
  assert.equal(
    view.select(null, { recoveryFailed: true, error: "unconfirmed" })?.phase,
    "recovery-failed",
  );
  assert.equal(view.select(null, {}), null);
});
test("partial activation recovery uses one stable panel identity without a published session", () => {
  let calls = 0;
  const view = new PanelRecoveryView(() => {
    calls++;
    return { ...shared, sessionId: `recovery-${calls}` };
  });
  assert.equal(
    view.select(null, { recovering: true })?.sessionId,
    "recovery-1",
  );
  assert.equal(
    view.select(null, { recoveryFailed: true })?.sessionId,
    "recovery-1",
  );
  assert.equal(calls, 1);
  view.select(null, {});
  assert.equal(
    view.select(null, { recovering: true })?.sessionId,
    "recovery-2",
  );
});
test("a new confirmed sharing session does not inherit old recovery errors", () => {
  const view = new PanelRecoveryView(() => shared);
  view.select(shared, { recoveryFailed: true, error: "old" });
  const next = view.select({ ...shared, sessionId: "session-two" }, {});
  assert.equal(next?.phase, "sharing");
  assert.equal(next?.sessionId, "session-two");
  assert.equal(next?.error, undefined);
});
