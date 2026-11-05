import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const helper = resolve("native/bin/localshare-input");
test(
  "Mac capture filters suppress keys, buttons, movement and scrolling with a valid native protocol",
  { skip: process.platform !== "darwin" || !existsSync(helper) },
  () => {
    const events = execFileSync(helper, ["--self-test"], {
      encoding: "utf8",
      timeout: 10000,
    })
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1).type, "self-test");
    assert.equal(events.at(-1).suppressed, true);
    assert.equal(events.at(-1).hardwareDeltasPreserved, true);
    assert.equal(events.at(-1).syntheticSuppressed, true);
    const receivePolicy = events.at(-1).receivePolicy;
    assert.equal(
      typeof receivePolicy,
      "object",
      "native self-test must exercise manual receive policy",
    );
    assert.deepEqual(
      Object.keys(receivePolicy).sort(),
      [
        "manualPreserves",
        "manualEdges",
        "edgeReceiveReturn",
        "manualRelease",
        "manualEmergency",
        "manualReset",
        "manualPermissionFailure",
        "manualWatchdog",
      ].sort(),
    );
    for (const [name, passed] of Object.entries(receivePolicy)) {
      assert.equal(passed, true, `Mac receive policy: ${name}`);
    }
    const lifecycle = events.at(-1).lifecycle;
    assert.deepEqual(
      Object.keys(lifecycle).sort(),
      [
        "attachFailureRestore",
        "centerAndRestore",
        "detachFailure",
        "doubleRelease",
        "driftCorrection",
        "driftFailure",
        "hideFailure",
        "heldInputs",
        "escape",
        "noSteadyWarp",
        "repeatCapture",
        "releaseCommand",
        "permissionFailure",
        "releaseRetry",
        "shutdownRetry",
        "stop",
        "tapDisabled",
        "watchdog",
        "warpFailure",
        "warpVerificationFailure",
      ].sort(),
    );
    for (const [name, passed] of Object.entries(lifecycle)) {
      assert.equal(passed, true, `Mac capture lifecycle: ${name}`);
    }
    assert.deepEqual(
      events.slice(0, 6).map((e) => e.type),
      ["key", "key", "button", "button", "move", "scroll"],
    );
    assert.deepEqual(
      events.slice(0, 2).map((e) => ({ key: e.key, down: e.down })),
      [
        { key: 65, down: true },
        { key: 65, down: false },
      ],
    );
    assert.deepEqual(
      events.slice(2, 4).map((e) => ({ button: e.button, down: e.down })),
      [
        { button: 0, down: true },
        { button: 0, down: false },
      ],
    );
    const readiness = JSON.parse(
      execFileSync(helper, ["--check"], {
        encoding: "utf8",
        timeout: 10000,
      }).trim(),
    );
    assert.equal(typeof readiness.permission, "boolean");
    assert.equal(readiness.protocolVersion, 4);
  },
);
