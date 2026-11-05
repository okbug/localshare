import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Control } from "../src/core/control";
import { Extensions } from "../src/core/extensions";
import { makePeer } from "./helpers";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { request } from "../src/core/transport";
import { ClipboardSyncQueue } from "../src/core/clipboard-sync";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function setup(t: TestContext) {
  const a = await makePeer("A"),
    b = await makePeer("B");
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
  await ea.setSettings(true, true);
  await eb.setSettings(true, true);
  await ea.setPeer(d.fingerprint, { clipboard: true, control: true });
  await eb.setPeer(a.service.info.fingerprint, {
    clipboard: true,
    control: true,
  });
  let releases = 0;
  ca.input = {
    capture: async () => {},
    receive: async () => {},
    inject: () => {},
    release: () => {
      releases++;
    },
  };
  cb.input = {
    capture: async () => {},
    receive: async () => {},
    inject: () => {},
    release: () => {
      releases++;
    },
  };
  return { a, b, ea, eb, ca, cb, fp: d.fingerprint, releases: () => releases };
}

test("stopSharing releases immediately and pauses only this paired clipboard channel on both ends", async (t) => {
  const { a, ea, eb, ca, cb, fp, releases } = await setup(t);
  const c = await makePeer("Other");
  const ec = new Extensions(c.service);
  await ec.start();
  t.after(async () => {
    await ec.stop();
    await c.close();
  });
  ec.on("pairing", (p) => ec.respondPair(p.id, true));
  const other = await a.service.register("127.0.0.1", c.service.info.port);
  await ea.pair(other.fingerprint);
  await ea.setPeer(other.fingerprint, { clipboard: true });
  await ca.start(fp, "right", 0.5, "manual");
  const id = ea.snapshot().control.id;
  assert.equal(typeof id, "string");
  let drain!: () => void;
  ca.flushClipboard = () =>
    new Promise<void>((resolve) => {
      drain = resolve;
    });
  const stopped = ca.stopSharing(id);
  assert.equal(ca.mode, "local");
  assert.equal(ea.snapshot().trusted[0].clipboard, false);
  assert.ok(releases() > 0);
  drain();
  await stopped;
  assert.equal(cb.mode, "local");
  assert.equal(eb.snapshot().trusted[0].clipboard, false);
  assert.equal(ea.snapshot().clipboardEnabled, true);
  assert.equal(eb.snapshot().clipboardEnabled, true);
  assert.equal(ea.snapshot().trusted[0].control, true);
  assert.equal(eb.snapshot().trusted[0].control, true);
  assert.equal(
    ea.snapshot().trusted.find((p) => p.fingerprint === other.fingerprint)
      ?.clipboard,
    true,
  );
  const saved = JSON.parse(
    await readFile(join(a.root, "data/trust.json"), "utf8"),
  );
  assert.equal(
    saved.peers.find((p: { fingerprint: string }) => p.fingerprint === fp)
      .clipboard,
    false,
  );
  assert.equal(
    saved.peers.find(
      (p: { fingerprint: string }) => p.fingerprint === other.fingerprint,
    ).clipboard,
    true,
  );
});

test("normal return preserves clipboard and stale panel or wire stops cannot affect a newer same-peer session", async (t) => {
  const { ea, eb, ca, cb, fp } = await setup(t);
  await ca.start(fp, "right", 0.5, "manual");
  const old = ea.snapshot().control.id;
  await ca.stop();
  assert.equal(ea.snapshot().trusted[0].clipboard, true);
  assert.equal(eb.snapshot().trusted[0].clipboard, true);
  await ca.start(fp, "right", 0.5, "manual");
  await ca.stopSharing(old);
  assert.equal(ca.mode, "sending");
  const response = await ea.call(fp, "/control/stop", {
    id: old,
    stopClipboard: true,
  });
  assert.deepEqual(JSON.parse(response.body.toString()), {
    ok: true,
    clipboardStopped: false,
  });
  assert.equal(cb.mode, "receiving");
  assert.equal(eb.snapshot().trusted[0].clipboard, true);
  assert.equal(ea.snapshot().trusted[0].clipboard, true);
});

test("a matching ended session can finish clipboard pause without stopping unrelated new input", async (t) => {
  const { ea, eb, ca, fp } = await setup(t);
  await ca.start(fp, "right", 0.5, "manual");
  const id = ea.snapshot().control.id;
  await ca.stop();
  const response = await ea.call(fp, "/control/stop", {
    id,
    stopClipboard: true,
  });
  assert.equal(JSON.parse(response.body.toString()).clipboardStopped, true);
  assert.equal(eb.snapshot().trusted[0].clipboard, false);
  const invalid = await ea.call(fp, "/control/stop", {
    id,
    stopClipboard: "true",
  });
  assert.equal(invalid.status, 400);
});

test("native release errors and clipboard drain failures cannot keep the session active", async (t) => {
  const { ea, eb, ca, fp } = await setup(t);
  const notices: string[] = [];
  ea.on("notice", (text) => notices.push(text));
  await ca.start(fp, "right", 0.5, "manual");
  ca.input!.release = () => {
    throw new Error("native pipe closed");
  };
  ca.flushClipboard = async () => {
    throw new Error("backend drain failed");
  };
  await ca.stopSharing(ea.snapshot().control.id);
  assert.equal(ca.mode, "local");
  assert.equal(ea.snapshot().trusted[0].clipboard, false);
  assert.equal(eb.snapshot().trusted[0].clipboard, false);
  assert.ok(notices.length > 0);
});

test("incoming clipboard paused during body read stays invalid after permission is re-enabled", async (t) => {
  const { a, ea, eb, b, fp } = await setup(t);
  const started = deferred<void>();
  const original = b.service.extensionHandler!;
  b.service.extensionHandler = async (req, res, url) => {
    if (url.pathname.endsWith("/clipboard"))
      req.once("data", () => started.resolve());
    return original(req, res, url);
  };
  let delivered = 0;
  eb.on("clipboard", () => delivered++);
  const saved = JSON.parse(
    await readFile(join(a.root, "data/trust.json"), "utf8"),
  );
  const token = saved.peers.find(
    (p: { fingerprint: string }) => p.fingerprint === fp,
  ).outbound;
  const body = new PassThrough();
  const text = JSON.stringify({ text: "old body" });
  const response = request(
    a.service.identity,
    a.service.devices.get(fp)!,
    "/api/localshare/v1/clipboard",
    {
      stream: body,
      size: Buffer.byteLength(text),
      headers: { authorization: `Bearer ${token}` },
      timeout: 2000,
    },
  );
  body.write(text.slice(0, 8));
  await started.promise;
  await eb.pauseClipboard(a.service.info.fingerprint);
  await eb.setPeer(a.service.info.fingerprint, { clipboard: true });
  body.end(text.slice(8));
  assert.equal((await response).status, 409);
  assert.equal(delivered, 0);
});

test("revoking a peer aborts an external clipboard send already waiting for a response", async (t) => {
  const { a, ea, b, fp } = await setup(t);
  const started = deferred<void>(),
    unblock = deferred<void>(),
    closed = deferred<void>();
  const original = b.service.extensionHandler!;
  b.service.extensionHandler = async (req, res, url) => {
    if (url.pathname.endsWith("/clipboard")) {
      res.once("close", () => closed.resolve());
      started.resolve();
      await unblock.promise;
    }
    return original(req, res, url);
  };
  const sending = ea.sendClipboard("in flight");
  await started.promise;
  await ea.pauseClipboard(fp);
  await Promise.race([
    sending,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("send was not aborted")),
        1000,
      );
      timer.unref();
    }),
  ]);
  await closed.promise;
  unblock.resolve();
  assert.equal(
    ea.snapshot().trusted.find((p) => p.fingerprint === fp)?.clipboard,
    false,
  );
  assert.equal(ea.snapshot().clipboardEnabled, true);
});

test("queued real inbound clipboard leases cannot revive after revoke and re-enable", async (t) => {
  const { a, ea, eb, fp } = await setup(t);
  const baseline = deferred<string>();
  const writes: string[] = [];
  const q = new ClipboardSyncQueue(
    eb,
    {
      readText: () => baseline.promise,
      writeText: (text) => {
        writes.push(text);
      },
    },
    0,
  );
  t.after(() => q.stop());
  await ea.sendClipboard("queued old value");
  await eb.pauseClipboard(a.service.info.fingerprint);
  await eb.setPeer(a.service.info.fingerprint, { clipboard: true });
  baseline.resolve("unchanged");
  await q.flush();
  assert.deepEqual(writes, []);
  await ea.sendClipboard("queued old value");
  await q.flush();
  assert.deepEqual(writes, ["queued old value"]);
});

test("stop confirmation waits the receiver's issued OS write but never holds native input", async (t) => {
  const { a, ea, eb, ca, cb, fp } = await setup(t);
  const issued = deferred<void>(),
    complete = deferred<void>();
  const writes: string[] = [];
  const q = new ClipboardSyncQueue(
    eb,
    {
      readText: () => "",
      writeText: async (text) => {
        writes.push(text);
        issued.resolve();
        await complete.promise;
      },
    },
    0,
  );
  t.after(() => q.stop());
  cb.flushClipboard = () => q.flush();
  await q.flush();
  await ca.start(fp, "right", 0.5, "manual");
  await ea.sendClipboard("already issued");
  await issued.promise;
  const paused = deferred<void>();
  eb.once("trustChanged", () => paused.resolve());
  let confirmed = false;
  const stopping = ca.stopSharing(ea.snapshot().control.id).then(() => {
    confirmed = true;
  });
  await paused.promise;
  assert.equal(ca.mode, "local");
  assert.equal(cb.mode, "local");
  assert.equal(confirmed, false);
  assert.equal(eb.snapshot().trusted[0].clipboard, false);
  complete.resolve();
  await stopping;
  assert.deepEqual(writes, ["already issued"]);
  assert.equal(
    (await ea.call(fp, "/clipboard", { text: "after stop" })).status,
    409,
  );
});

test("global permission revoke and re-enable invalidates an older queued inbound payload", async (t) => {
  const { ea, eb } = await setup(t);
  const baseline = deferred<string>();
  const writes: string[] = [];
  const q = new ClipboardSyncQueue(
    eb,
    {
      readText: () => baseline.promise,
      writeText: (text) => {
        writes.push(text);
      },
    },
    0,
  );
  t.after(() => q.stop());
  await ea.sendClipboard("old generation");
  await eb.setSettings(false, true);
  await eb.setSettings(true, true);
  baseline.resolve("baseline");
  await q.flush();
  assert.deepEqual(writes, []);
  await ea.sendClipboard("old generation");
  await q.flush();
  assert.deepEqual(writes, ["old generation"]);
});

test("synchronous flush exceptions are reported without rejecting or retaining physical capture", async (t) => {
  const { ea, eb, ca, cb, fp } = await setup(t);
  const notices: string[] = [];
  ea.on("notice", (text) => notices.push(text));
  ca.flushClipboard = () => {
    throw new Error("local synchronous backend error");
  };
  cb.flushClipboard = () => {
    throw new Error("remote synchronous backend error");
  };
  await ca.start(fp, "right", 0.5, "manual");
  await ca.stopSharing(ea.snapshot().control.id);
  assert.equal(ca.mode, "local");
  assert.equal(cb.mode, "local");
  assert.equal(ea.snapshot().trusted[0].clipboard, false);
  assert.equal(eb.snapshot().trusted[0].clipboard, false);
  assert.ok(notices.length > 0);
});
