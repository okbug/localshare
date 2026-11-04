import { test } from "node:test";
import assert from "node:assert/strict";
import { Extensions } from "../src/core/extensions";
import { Control } from "../src/core/control";
import { makePeer } from "./helpers";
const waitFor = async (fn: () => boolean) => {
  const until = Date.now() + 4000;
  while (!fn()) {
    if (Date.now() > until) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
test("control is opt-in, delivers ordered events and emergency stop releases both peers", async () => {
  const a = await makePeer("A"),
    b = await makePeer("B");
  const ea = new Extensions(a.service),
    eb = new Extensions(b.service);
  const ca = new Control(ea),
    cb = new Control(eb);
  try {
    await ea.start();
    await eb.start();
    const d = await a.service.register("127.0.0.1", b.service.info.port);
    await assert.rejects(ca.start(d.fingerprint, "right", 0.5), /开启/);
    ea.on("pairing", (p) => ea.respondPair(p.id, true));
    eb.on("pairing", (p) => eb.respondPair(p.id, true));
    await ea.pair(d.fingerprint);
    await ea.setSettings(false, true);
    await eb.setSettings(false, true);
    await ea.setPeer(d.fingerprint, { control: true });
    await eb.setPeer(a.service.info.fingerprint, { control: true });
    const seen: unknown[] = [];
    cb.on("input", (e) => seen.push(e));
    await ca.start(d.fingerprint, "right", 0.5);
    assert.equal(ca.mode, "sending");
    assert.equal(cb.mode, "receiving");
    ca.push({ type: "key", key: 65, down: true });
    ca.push({ type: "key", key: 65, down: false });
    ca.push({ type: "move", dx: 10, dy: 0 });
    await waitFor(() => seen.length === 3);
    assert.deepEqual(seen, [
      { type: "key", key: 65, down: true },
      { type: "key", key: 65, down: false },
      { type: "move", dx: 10, dy: 0 },
    ]);
    await ca.stop();
    await waitFor(() => cb.mode === "local");
    assert.equal(ca.mode, "local");
  } finally {
    await ca.dispose();
    await cb.dispose();
    await ea.stop();
    await eb.stop();
    await a.close();
    await b.close();
  }
});
test("malformed input is rejected and a disconnected peer returns to local control", async () => {
  const a = await makePeer("A"),
    b = await makePeer("B");
  const ea = new Extensions(a.service),
    eb = new Extensions(b.service);
  const ca = new Control(ea),
    cb = new Control(eb);
  try {
    await ea.start();
    await eb.start();
    const d = await a.service.register("127.0.0.1", b.service.info.port);
    ea.on("pairing", (p) => ea.respondPair(p.id, true));
    eb.on("pairing", (p) => eb.respondPair(p.id, true));
    await ea.pair(d.fingerprint);
    await ea.setSettings(false, true);
    await eb.setSettings(false, true);
    await ea.setPeer(d.fingerprint, { control: true });
    await eb.setPeer(a.service.info.fingerprint, { control: true });
    await ca.start(d.fingerprint, "right", 0.2);
    assert.throws(
      () => ca.push({ type: "key", key: 999999, down: true }),
      /输入事件/,
    );
    // Simulate the receiving process disappearing: stop its outbound heartbeat
    // without sending the graceful stop message to the controller.
    await cb.stop(false);
    await waitFor(() => ca.mode === "local");
  } finally {
    await ca.dispose();
    await cb.dispose();
    await ea.stop();
    await eb.stop();
    await a.close();
    await b.close();
  }
});
