import { test } from "node:test";
import assert from "node:assert/strict";
import { Extensions } from "../src/core/extensions";
import { makePeer } from "./helpers";
import { request } from "../src/core/transport";
test("clipboard requires both-way confirmed pairing, explicit switches, and deduplicates", async () => {
  const a = await makePeer("Mac");
  const b = await makePeer("Windows");
  const ea = new Extensions(a.service);
  const eb = new Extensions(b.service);
  try {
    await ea.start();
    await eb.start();
    const d = await a.service.register("127.0.0.1", b.service.info.port);
    assert.equal(
      (
        await request(a.service.identity, d, "/api/localshare/v1/clipboard", {
          json: { text: "secret" },
        })
      ).status,
      403,
    );
    ea.on("pairing", (p) => ea.respondPair(p.id, true));
    eb.on("pairing", (p) => eb.respondPair(p.id, true));
    await ea.pair(d.fingerprint);
    assert.equal(ea.snapshot().trusted.length, 1);
    assert.equal(eb.snapshot().trusted.length, 1);
    let text = "";
    let count = 0;
    eb.on("clipboard", (value) => {
      text = value;
      count++;
    });
    await ea.sendClipboard("disabled");
    assert.equal(text, "");
    await ea.setSettings(true, false);
    await eb.setSettings(true, false);
    await ea.setPeer(d.fingerprint, { clipboard: true });
    await eb.setPeer(a.service.info.fingerprint, { clipboard: true });
    await ea.sendClipboard("hello from mac");
    assert.equal(text, "hello from mac");
    await ea.sendClipboard("hello from mac");
    assert.equal(count, 1);
    await eb.sendClipboard("edited on windows");
    await ea.sendClipboard("hello from mac");
    assert.equal(
      count,
      2,
      "re-copying an earlier value after a remote edit must sync again",
    );
    eb.noteClipboardChange("");
    await ea.sendClipboard("hello from mac");
    assert.equal(
      count,
      3,
      "clearing the local clipboard must allow the same value again",
    );
    a.service.devices.set(d.fingerprint, { ...d, protocol: "http" });
    await assert.rejects(
      ea.call(d.fingerprint, "/clipboard", { text: "must not leave TLS" }),
      /HTTPS/,
    );
    a.service.devices.set(d.fingerprint, d);
    await ea.unpair(d.fingerprint);
    assert.equal(ea.snapshot().trusted.length, 0);
    assert.equal(eb.snapshot().trusted.length, 0);
  } finally {
    await ea.stop();
    await eb.stop();
    await a.close();
    await b.close();
  }
});
test("pairing rejected on either device cannot grant trust", async () => {
  const a = await makePeer("A");
  const b = await makePeer("B");
  const ea = new Extensions(a.service);
  const eb = new Extensions(b.service);
  try {
    await ea.start();
    await eb.start();
    const d = await a.service.register("127.0.0.1", b.service.info.port);
    ea.on("pairing", (p) => ea.respondPair(p.id, true));
    eb.on("pairing", (p) => eb.respondPair(p.id, false));
    await assert.rejects(ea.pair(d.fingerprint));
    assert.equal(ea.snapshot().trusted.length, 0);
    assert.equal(eb.snapshot().trusted.length, 0);
  } finally {
    await ea.stop();
    await eb.stop();
    await a.close();
    await b.close();
  }
});
