import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Control, type InputEvent } from "../src/core/control";
import { Extensions } from "../src/core/extensions";
import { makePeer } from "./helpers";

async function paired(t: TestContext) {
  const a = await makePeer("Windows"),
    b = await makePeer("Mac");
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
  const d = await a.service.register("127.0.0.1", b.service.info.port);
  ea.on("pairing", (p) => ea.respondPair(p.id, true));
  eb.on("pairing", (p) => eb.respondPair(p.id, true));
  await ea.pair(d.fingerprint);
  await ea.setSettings(false, true);
  await eb.setSettings(false, true);
  await ea.setPeer(d.fingerprint, { control: true });
  await eb.setPeer(a.service.info.fingerprint, { control: true });
  const injected: InputEvent[] = [];
  cb.input = {
    capture: async () => {},
    receive: async () => {},
    release: () => {},
    inject: (event) => injected.push(event),
  };
  async function send(events: InputEvent[]) {
    const before = injected.length;
    for (const event of events) ca.push(event);
    const until = Date.now() + 4000;
    while (injected.length < before + events.length) {
      if (Date.now() > until) throw new Error("input timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return injected.slice(before);
  }
  return { a, b, ea, eb, ca, cb, fp: d.fingerprint, send };
}

test("input preferences default off, persist independently, migrate old trust records and reject invalid patches atomically", async (t) => {
  const { a, ea, eb, fp } = await paired(t);
  for (const ext of [ea, eb]) {
    assert.equal(ext.snapshot().trusted[0].invertScroll, false);
    assert.equal(ext.snapshot().trusted[0].swapAltWin, false);
  }
  await ea.setPeer(fp, { invertScroll: true, swapAltWin: true });
  assert.equal(eb.snapshot().trusted[0].invertScroll, false);
  assert.equal(eb.snapshot().trusted[0].swapAltWin, false);
  await assert.rejects(
    ea.setPeer(fp, { invertScroll: false, swapAltWin: "true" } as never),
    /开关值无效/,
  );
  assert.equal(ea.snapshot().trusted[0].invertScroll, true);
  await ea.stop();
  const restored = new Extensions(a.service);
  await restored.start();
  assert.equal(restored.snapshot().trusted[0].invertScroll, true);
  assert.equal(restored.snapshot().trusted[0].swapAltWin, true);
  assert.equal(restored.snapshot().controlEnabled, false);
  await restored.stop();
  const path = join(a.service.options.dataDir, "trust.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  delete saved.peers[0].invertScroll;
  delete saved.peers[0].swapAltWin;
  await writeFile(path, JSON.stringify(saved));
  const legacy = new Extensions(a.service);
  await legacy.start();
  assert.equal(legacy.snapshot().trusted[0].invertScroll, false);
  assert.equal(legacy.snapshot().trusted[0].swapAltWin, false);
  await legacy.stop();
});

const keys: InputEvent[] = [164, 165, 91, 92, 162, 163, 160, 161, 65].flatMap(
  (key) => [
    { type: "key", key, down: true },
    { type: "key", key, down: false },
  ],
);
const other: InputEvent[] = [
  { type: "scroll", dx: 2, dy: -3 },
  { type: "scroll", dx: 0, dy: 1 },
  { type: "move", dx: 3, dy: -4 },
  { type: "button", button: 0, down: true },
  { type: "button", button: 0, down: false },
];

test("only the sending peer's opt-in preferences change scroll and modifier input, preserving left/right and key releases", async (t) => {
  const { a, ea, eb, ca, fp, send } = await paired(t);
  await eb.setPeer(a.service.info.fingerprint, {
    invertScroll: true,
    swapAltWin: true,
  });
  await ca.start(fp, "right", 0.5);
  assert.deepEqual(await send([...keys, ...other]), [...keys, ...other]);
  await ca.stop();
  await ea.setPeer(fp, { invertScroll: true });
  await ca.start(fp, "right", 0.5);
  assert.deepEqual(await send([...keys, ...other]), [
    ...keys,
    { type: "scroll", dx: -2, dy: 3 },
    { type: "scroll", dx: 0, dy: -1 },
    ...other.slice(2),
  ]);
  await ca.stop();
  await ea.setPeer(fp, { invertScroll: false, swapAltWin: true });
  await ca.start(fp, "right", 0.5);
  const mappedKeys: InputEvent[] = [
    91, 92, 164, 165, 162, 163, 160, 161, 65,
  ].flatMap((key) => [
    { type: "key", key, down: true },
    { type: "key", key, down: false },
  ]);
  assert.deepEqual(await send([...keys, ...other]), [...mappedKeys, ...other]);
  await ca.stop();
  await ea.setPeer(fp, { invertScroll: true });
  await ca.start(fp, "right", 0.5);
  assert.deepEqual(await send([...keys, other[0]]), [
    ...mappedKeys,
    { type: "scroll", dx: -2, dy: 3 },
  ]);
  assert.deepEqual(
    other[0],
    { type: "scroll", dx: 2, dy: -3 },
    "mapping must not mutate the captured event",
  );
});

test("changing preferences while a modifier is held keeps the matching release and applies on the next crossing", async (t) => {
  const { ea, ca, fp, send } = await paired(t);
  await ea.setPeer(fp, { swapAltWin: true, invertScroll: true });
  await ca.start(fp, "right", 0.5);
  assert.deepEqual(await send([{ type: "key", key: 164, down: true }]), [
    { type: "key", key: 91, down: true },
  ]);
  await ea.setPeer(fp, { swapAltWin: false, invertScroll: false });
  assert.deepEqual(
    await send([{ type: "key", key: 164, down: false }, other[0]]),
    [
      { type: "key", key: 91, down: false },
      { type: "scroll", dx: -2, dy: 3 },
    ],
  );
  await ca.stop();
  await ca.start(fp, "right", 0.5);
  assert.deepEqual(await send([...keys, ...other]), [...keys, ...other]);
});
