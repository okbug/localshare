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
test("movement arriving while a response is in flight keeps a new sequence number", async () => {
  const a = await makePeer("A"),
    b = await makePeer("B");
  const ea = new Extensions(a.service),
    eb = new Extensions(b.service);
  const ca = new Control(ea),
    cb = new Control(eb);
  let release: (() => void) | undefined;
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
    let responseReady: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      responseReady = resolve;
    });
    let held = false;
    const original = eb.call.bind(eb);
    eb.call = async (...args: Parameters<Extensions["call"]>) => {
      const response = await original(...args);
      if (
        args[1] === "/control/events" &&
        !held &&
        JSON.parse(response.body.toString()).events?.length
      ) {
        held = true;
        responseReady();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return response;
    };
    const received: unknown[] = [];
    cb.on("input", (e) => received.push(e));
    await ca.start(d.fingerprint, "right", 0.5);
    ca.push({ type: "move", dx: 1, dy: 0 });
    await inFlight;
    ca.push({ type: "move", dx: 9, dy: 0 });
    release!();
    await waitFor(() => received.length === 2);
    assert.deepEqual(received, [
      { type: "move", dx: 1, dy: 0 },
      { type: "move", dx: 9, dy: 0 },
    ]);
  } finally {
    release?.();
    await ca.dispose();
    await cb.dispose();
    await ea.stop();
    await eb.stop();
    await a.close();
    await b.close();
  }
});
test("a failed remote input adapter releases both devices before input starts", async () => {
  const a = await makePeer("A"),
    b = await makePeer("B");
  const ea = new Extensions(a.service),
    eb = new Extensions(b.service);
  const ca = new Control(ea),
    cb = new Control(eb);
  let localReleased = 0,
    remoteReleased = 0;
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
    ca.input = {
      capture: async () => {},
      receive: async () => {},
      inject: () => {},
      release: () => {
        localReleased++;
      },
    };
    cb.input = {
      capture: async () => {},
      receive: async () => {
        throw new Error("无法准备输入注入");
      },
      inject: () => {},
      release: () => {
        remoteReleased++;
      },
    };
    await assert.rejects(
      ca.start(d.fingerprint, "right", 0.5),
      /无法准备输入注入/,
    );
    assert.equal(ca.mode, "local");
    assert.equal(cb.mode, "local");
    assert.equal(localReleased, 1);
    assert.equal(remoteReleased, 1);
  } finally {
    await ca.dispose();
    await cb.dispose();
    await ea.stop();
    await eb.stop();
    await a.close();
    await b.close();
  }
});
test("a failed native capture never activates the remote device", async () => {
  const a = await makePeer("A"),
    b = await makePeer("B");
  const ea = new Extensions(a.service),
    eb = new Extensions(b.service);
  const ca = new Control(ea),
    cb = new Control(eb);
  let releases = 0;
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
    ca.input = {
      capture: async () => {
        throw new Error("原生截获失败");
      },
      receive: async () => {},
      inject: () => {},
      release: () => {
        releases++;
      },
    };
    await assert.rejects(ca.start(d.fingerprint, "right", 0.5), /原生截获失败/);
    assert.equal(ca.mode, "local");
    assert.equal(cb.mode, "local");
    assert.equal(releases, 1);
  } finally {
    await ca.dispose();
    await cb.dispose();
    await ea.stop();
    await eb.stop();
    await a.close();
    await b.close();
  }
});

test("unsent motion is coalesced without losing click/key order or mutating delivered sequence numbers", async () => {
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
    const seen: unknown[] = [];
    cb.on("input", (e) => seen.push(e));
    await ca.start(d.fingerprint, "right", 0.5);
    for (let i = 0; i < 100; i++) ca.push({ type: "move", dx: 1, dy: 0 });
    ca.push({ type: "button", button: 0, down: true });
    for (let i = 0; i < 10; i++) ca.push({ type: "move", dx: 1, dy: 0 });
    ca.push({ type: "button", button: 0, down: false });
    ca.push({ type: "key", key: 65, down: true });
    ca.push({ type: "key", key: 65, down: false });
    await waitFor(() => seen.length === 6);
    assert.deepEqual(seen, [
      { type: "move", dx: 100, dy: 0 },
      { type: "button", button: 0, down: true },
      { type: "move", dx: 10, dy: 0 },
      { type: "button", button: 0, down: false },
      { type: "key", key: 65, down: true },
      { type: "key", key: 65, down: false },
    ]);
    ca.push({ type: "move", dx: 9, dy: 2 });
    await waitFor(() => seen.length === 7);
    assert.deepEqual(seen[6], { type: "move", dx: 9, dy: 2 });
  } finally {
    await ca.dispose();
    await cb.dispose();
    await ea.stop();
    await eb.stop();
    await a.close();
    await b.close();
  }
});
test("remote control setup errors name the receiving device and the missing switch without raw JSON", async () => {
  const a = await makePeer("Mac 测试"),
    b = await makePeer("Windows 测试");
  const ea = new Extensions(a.service),
    eb = new Extensions(b.service);
  const ca = new Control(ea),
    cb = new Control(eb);
  try {
    await ea.start();
    await eb.start();
    const device = await a.service.register("127.0.0.1", b.service.info.port);
    ea.on("pairing", (p) => ea.respondPair(p.id, true));
    eb.on("pairing", (p) => eb.respondPair(p.id, true));
    await ea.pair(device.fingerprint);
    await ea.setSettings(false, true);
    await ea.setPeer(device.fingerprint, { control: true });
    await assert.rejects(
      ca.start(device.fingerprint, "right", 0.5),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Windows 测试/);
        assert.match(error.message, /总开关/);
        assert.equal(error.message.startsWith("{"), false);
        return true;
      },
    );
    assert.equal(ca.mode, "local");
    await eb.setSettings(false, true);
    await assert.rejects(
      ca.start(device.fingerprint, "right", 0.5),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Windows 测试/);
        assert.match(error.message, /设备卡片/);
        assert.match(error.message, /Mac 测试/);
        return true;
      },
    );
    assert.equal(ca.mode, "local");
    await eb.setPeer(a.service.info.fingerprint, { control: true });
    await ca.start(device.fingerprint, "right", 0.5);
    assert.equal(ca.mode, "sending");
  } finally {
    await ca.dispose();
    await cb.dispose();
    await ea.stop();
    await eb.stop();
    await a.close();
    await b.close();
  }
});
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
