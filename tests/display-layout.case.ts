import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Extensions } from "../src/core/extensions";
import { Control } from "../src/core/control";
import { request } from "../src/core/transport";
import { makePeer } from "./helpers";

const layout = {
  version: 1,
  platform: "windows",
  entrySelection: true,
  displays: [
    {
      id: "DISPLAY2",
      name: "Left portrait",
      x: -1080,
      y: -200,
      width: 1080,
      height: 1920,
      primary: false,
    },
    {
      id: "DISPLAY1",
      name: "Main",
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      primary: true,
    },
  ],
};
async function paired(t: TestContext) {
  const a = await makePeer("Mac"),
    b = await makePeer("Windows");
  const ea = new Extensions(a.service),
    eb = new Extensions(b.service);
  const ca = new Control(ea),
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
  const device = await a.service.register("127.0.0.1", b.service.info.port);
  ea.on("pairing", (p) => ea.respondPair(p.id, true));
  eb.on("pairing", (p) => eb.respondPair(p.id, true));
  await ea.pair(device.fingerprint);
  return { a, b, ea, eb, ca, cb, device };
}

test("display topology is restricted to paired TLS peers, validated, cached and cleared on unpair", async (t) => {
  const { a, ea, eb, device } = await paired(t);
  eb.displayProvider = async () => structuredClone(layout) as never;
  assert.equal(
    (
      await request(a.service.identity, device, "/api/localshare/v1/displays", {
        json: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (await ea.call(device.fingerprint, "/displays", {})).status,
    200,
  );
  assert.deepEqual(await ea.fetchDisplayLayout(device.fingerprint), layout);
  assert.deepEqual(ea.snapshot().displayLayouts?.[device.fingerprint], layout);
  assert.equal(ea.snapshot().trusted[0].entryDisplay, "");
  await ea.setPeer(device.fingerprint, { entryDisplay: "DISPLAY2" });
  await assert.rejects(
    ea.setPeer(device.fingerprint, { entryDisplay: 'DISPLAY1"\n' }),
    /入口/,
  );
  eb.displayProvider = async () =>
    ({
      ...layout,
      displays: [
        layout.displays[0],
        { ...layout.displays[1], x: -3000, y: -200, height: 1920 },
      ],
    }) as never;
  await ea.fetchDisplayLayout(device.fingerprint);
  assert.equal(
    ea.snapshot().trusted[0].entryDisplay,
    "",
    "an existing display with its entrance fully blocked must revert to automatic",
  );
  await ea.setPeer(device.fingerprint, { entryDisplay: "DISPLAY2" });
  eb.displayProvider = async () =>
    ({ ...layout, displays: [layout.displays[1]] }) as never;
  await ea.fetchDisplayLayout(device.fingerprint);
  assert.equal(
    ea.snapshot().trusted[0].entryDisplay,
    "",
    "unplugged selection must revert to automatic",
  );
  await ea.unpair(device.fingerprint);
  assert.equal(ea.snapshot().displayLayouts?.[device.fingerprint], undefined);
});

test("malformed display metadata is rejected and unsupported peers have an explicit upgrade message", async (t) => {
  const { ea, eb, device } = await paired(t);
  await assert.rejects(
    ea.fetchDisplayLayout(device.fingerprint),
    /不支持|升级/,
  );
  const invalid = [
    { ...layout, version: 2 },
    { ...layout, displays: [] },
    { ...layout, displays: Array(33).fill(layout.displays[0]) },
    { ...layout, displays: [{ ...layout.displays[0], width: -1 }] },
    { ...layout, displays: [{ ...layout.displays[0], x: 0.5 }] },
    { ...layout, displays: [{ ...layout.displays[0], x: 1000001 }] },
    { ...layout, displays: [{ ...layout.displays[0], id: 'evil"' }] },
    { ...layout, displays: [layout.displays[0], layout.displays[0]] },
  ];
  for (const data of invalid) {
    eb.displayProvider = async () => data as never;
    await assert.rejects(
      ea.fetchDisplayLayout(device.fingerprint),
      /屏幕|布局/,
    );
  }
  assert.equal(ea.snapshot().displayLayouts?.[device.fingerprint], undefined);
});

test("selected display is verified before capture and forwarded only for that session", async (t) => {
  const { a, ea, eb, ca, cb, device } = await paired(t);
  eb.displayProvider = async () => structuredClone(layout) as never;
  await ea.setSettings(false, true);
  await eb.setSettings(false, true);
  await ea.setPeer(device.fingerprint, {
    control: true,
    entryDisplay: "DISPLAY2",
  });
  await eb.setPeer(a.service.info.fingerprint, { control: true });
  let captured = 0;
  const received: unknown[] = [];
  ca.input = {
    capture: async () => {
      captured++;
    },
    receive: async () => {},
    inject: () => {},
    release: () => {},
  };
  cb.input = {
    capture: async () => {},
    receive: async (p) => {
      received.push(p);
    },
    inject: () => {},
    release: () => {},
  };
  await ca.start(device.fingerprint, "right", 0.4);
  assert.deepEqual(received[0], { side: "right", y: 0.4, display: "DISPLAY2" });
  await ca.stop();
  eb.displayProvider = undefined;
  await assert.rejects(
    ca.start(device.fingerprint, "right", 0.4),
    /不支持|升级/,
  );
  assert.equal(
    captured,
    1,
    "unsupported layout must fail before capturing the local cursor",
  );
  await ea.setPeer(device.fingerprint, { entryDisplay: "" });
  await ca.start(device.fingerprint, "right", 0.4);
  assert.deepEqual(received[1], { side: "right", y: 0.4 });
});

test("a cancelled layout preflight cannot stop a newer control session", async (t) => {
  const { a, ea, eb, ca, cb, device } = await paired(t);
  await ea.setSettings(false, true);
  await eb.setSettings(false, true);
  await ea.setPeer(device.fingerprint, {
    control: true,
    entryDisplay: "DISPLAY2",
  });
  await eb.setPeer(a.service.info.fingerprint, { control: true });
  let resume: () => void = () => {},
    begun: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    begun = resolve;
  });
  eb.displayProvider = async () => {
    begun();
    await new Promise<void>((resolve) => {
      resume = resolve;
    });
    return layout as never;
  };
  const old = ca.start(device.fingerprint, "right", 0.5);
  const rejected = assert.rejects(old, /取消/);
  try {
    await ready;
    await ca.stop(false);
    await ea.setPeer(device.fingerprint, { entryDisplay: "" });
    await ca.start(device.fingerprint, "right", 0.5);
    assert.equal(ca.mode, "sending");
    resume();
    await rejected;
    assert.equal(
      ca.mode,
      "sending",
      "stale failure must leave the newer session active",
    );
    assert.equal(cb.mode, "receiving");
  } finally {
    resume();
    await rejected;
  }
});

test("a stale incoming native activation cannot stop a newer receiving session", async (t) => {
  const { a, ea, eb, cb, device } = await paired(t);
  await eb.setSettings(false, true);
  await eb.setPeer(a.service.info.fingerprint, { control: true });
  let resume: () => void = () => {},
    begun: () => void = () => {},
    calls = 0;
  const ready = new Promise<void>((resolve) => {
    begun = resolve;
  });
  const call = eb.call.bind(eb);
  eb.call = (...args: Parameters<Extensions["call"]>) =>
    args[1] === "/control/events"
      ? new Promise((_, reject) => {
          args[3]?.signal?.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        })
      : call(...args);
  cb.input = {
    capture: async () => {},
    inject: () => {},
    release: () => {},
    receive: async () => {
      if (calls++ === 0) {
        begun();
        await new Promise<void>((resolve) => {
          resume = resolve;
        });
      }
    },
  };
  const old = ea.call(device.fingerprint, "/control/start", {
    id: "old",
    side: "right",
    y: 0.5,
  });
  try {
    await ready;
    await cb.stop(false);
    assert.equal(
      (
        await ea.call(device.fingerprint, "/control/start", {
          id: "new",
          side: "right",
          y: 0.5,
        })
      ).status,
      200,
    );
    resume();
    assert.equal((await old).status, 503);
    assert.equal(
      cb.mode,
      "receiving",
      "stale receive cleanup must not release the new session",
    );
  } finally {
    resume();
    await old;
  }
});
