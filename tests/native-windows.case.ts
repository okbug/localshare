import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseDisplayLayout } from "../src/shared/displays";

const helper = resolve("native/bin/localshare-input.exe");
test(
  "Windows helper reads its real physical desktop without hooks or injected input",
  {
    skip: process.platform !== "win32" || !existsSync(helper),
  },
  () => {
    const selfTest = JSON.parse(
      execFileSync(helper, ["--self-test"], {
        encoding: "utf8",
        timeout: 10000,
      }),
    );
    assert.equal(selfTest.type, "self-test");
    assert.equal(selfTest.geometry, true);
    assert.equal(selfTest.manualReceive, true);
    assert.equal(selfTest.releaseProtocol, true);
    assert.equal(selfTest.passed, true);
    const layout = parseDisplayLayout(
      JSON.parse(
        execFileSync(helper, ["--layout"], {
          encoding: "utf8",
          timeout: 10000,
        }),
      ),
    );
    assert.ok(layout.displays.length >= 1);
    assert.equal(layout.displays.filter((d) => d.primary).length, 1);
    const ready = JSON.parse(
      execFileSync(helper, ["--check"], { encoding: "utf8", timeout: 10000 }),
    );
    assert.equal(ready.protocolVersion, 5);
    assert.equal(ready.permission, true);
    assert.deepEqual(parseDisplayLayout(ready), layout);
  },
);
