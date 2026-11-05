import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Control } from "../src/core/control";
import { Extensions } from "../src/core/extensions";
import { reply } from "../src/core/service";
import { makePeer } from "./helpers";

async function paired(t: TestContext) {
  const a = await makePeer("Mac"),
    b = await makePeer("Windows");
  const ea = new Extensions(a.service),
    eb = new Extensions(b.service),
    ca = new Control(ea),
    cb = new Control(eb);
  t.after(async () => {
    await ca.dispose();
    await cb.dispose();
    await ea.stop();
    await eb.stop();
    await a.close();
    await b.close();
  });
  await ea.start();
  await eb.start();
  const d = await a.service.register("127.0.0.1", b.service.info.port);
  ea.on("pairing", (p) => ea.respondPair(p.id, true));
  eb.on("pairing", (p) => eb.respondPair(p.id, true));
  await ea.pair(d.fingerprint);
  let captures = 0,
    releases = 0;
  const positions: unknown[] = [],
    events: unknown[] = [];
  ca.input = {
    capture: async () => {
      captures++;
    },
    receive: async () => {},
    inject: () => {},
    release: () => {
      releases++;
    },
  };
  cb.input = {
    capture: async () => {},
    receive: async (p) => {
      positions.push(p);
    },
    inject: (e) => events.push(e),
    release: () => {
      releases++;
    },
  };
  async function enable() {
    await ea.setSettings(false, true);
    await eb.setSettings(false, true);
    await ea.setPeer(d.fingerprint, { control: true });
    await eb.setPeer(a.service.info.fingerprint, { control: true });
  }
  return {
    a,
    b,
    ea,
    eb,
    ca,
    cb,
    fp: d.fingerprint,
    positions,
    events,
    enable,
    counts: () => ({ captures, releases }),
  };
}
async function until(fn: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("manual input control advertises authorization, ignores edge placement and delivers ordered input", async (t) => {
  const { ea, eb, ca, cb, fp, positions, events, enable, counts } =
    await paired(t);
  assert.equal((await ea.call(fp, "/control/capabilities", {})).status, 403);
  await enable();
  assert.deepEqual(
    JSON.parse(
      (await ea.call(fp, "/control/capabilities", {})).body.toString(),
    ),
    { version: 1, manual: true },
  );
  await ea.setPeer(fp, { side: "left", entryDisplay: "REMOVED" });
  await ca.start(fp, "right", 0.5, "manual");
  assert.deepEqual(positions, [{ side: "right", y: 0.5, manual: true }]);
  assert.equal(counts().captures, 1);
  assert.equal(ea.snapshot().control.interaction, "manual");
  assert.equal(eb.snapshot().control.interaction, "manual");
  assert.equal(ea.snapshot().control.fingerprint, fp);
  ca.push({ type: "move", dx: 1000, dy: -20 });
  ca.push({ type: "button", button: 0, down: true });
  ca.push({ type: "button", button: 0, down: false });
  ca.push({ type: "key", key: 65, down: true });
  ca.push({ type: "key", key: 65, down: false });
  await until(() => events.length === 5);
  assert.deepEqual(events.at(-1), { type: "key", key: 65, down: false });
  await assert.rejects(ca.start(fp, "left", 0.5), /已有活动/);
  await assert.rejects(
    cb.start(ea.service.info.fingerprint, "right", 0.5, "manual"),
    /已有活动/,
  );
  await cb.stop();
  await until(() => ca.mode === "local");
  assert.ok(counts().releases >= 2);
});

test("manual capability failure rejects an old peer before capturing local input", async (t) => {
  const { ea, eb, ca, fp, enable, positions, counts } = await paired(t);
  await enable();
  const original = eb.controlHandler!;
  for (const result of [
    undefined,
    null,
    [],
    { version: 1, manual: false },
    { version: 1, manual: "true" },
    { version: 2, manual: true },
  ]) {
    eb.controlHandler = async (req, res, url, peer) => {
      if (url.pathname.endsWith("/capabilities")) {
        reply(res, result === undefined ? 404 : 200, result);
        return true;
      }
      return original(req, res, url, peer);
    };
    await assert.rejects(ca.start(fp, "right", 0.5, "manual"), /升级|不支持/);
    assert.equal(counts().captures, 0);
    assert.deepEqual(positions, []);
    assert.equal(ca.mode, "local");
  }
  eb.controlHandler = original;
  await ea.setSettings(false, false);
  await assert.rejects(ca.start(fp, "right", 0.5, "manual"), /开启/);
});

test("edge mode stays compatible and malformed manual mode is rejected before native input", async (t) => {
  const { ea, ca, fp, enable, positions } = await paired(t);
  await enable();
  const invalid = await ea.call(fp, "/control/start", {
    id: "invalid",
    side: "right",
    y: 0.5,
    interaction: "anything",
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(positions, []);
  await ca.start(fp, "left", 0.25);
  assert.deepEqual(positions, [{ side: "left", y: 0.25 }]);
  assert.equal(ea.snapshot().control.interaction, "edge");
  await ca.stop();
});
