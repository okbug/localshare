import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ClipboardSyncQueue } from "../src/core/clipboard-sync";
import type { Extensions } from "../src/core/extensions";
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const source = new EventEmitter();
  let generation = 0;
  const sent: string[] = [],
    noted: string[] = [];
  const extensions = Object.assign(source, {
    snapshot: () => ({ clipboardEnabled: true }),
    noteClipboardChange: (s: string) => {
      noted.push(s);
    },
    prepareClipboardSend: () => {
      const lease = generation;
      return async (s: string) => {
        if (generation === lease) sent.push(s);
      };
    },
  });
  return {
    extensions: extensions as unknown as Extensions,
    source,
    sent,
    noted,
    permit: () => {
      const lease = generation;
      return () => lease === generation;
    },
    revoke: () => {
      generation++;
    },
  };
}

test("clipboard queue checks immutable permission at write time and does not echo inbound text", async () => {
  const f = fixture(),
    baseline = deferred<string>();
  const writes: string[] = [];
  let text = "initial",
    first = true;
  const q = new ClipboardSyncQueue(
    f.extensions,
    {
      readText: () => (first ? ((first = false), baseline.promise) : text),
      writeText: (s) => {
        writes.push(s);
        text = s;
      },
    },
    0,
  );
  f.source.emit("clipboard", "stale", f.permit());
  f.revoke();
  baseline.resolve(text);
  await q.flush();
  assert.deepEqual(writes, []);
  f.source.emit("clipboard", "fresh", f.permit());
  await q.flush();
  assert.deepEqual(writes, ["fresh"]);
  await q.poll();
  await q.flush();
  assert.deepEqual(f.sent, []);
  q.stop();
  f.source.emit("clipboard", "after stop", () => true);
  await q.flush();
  assert.deepEqual(writes, ["fresh"]);
});

test("flush waits issued writes, preserves ordering, and revoked queued writes are discarded", async () => {
  const f = fixture(),
    write = deferred<void>();
  const writes: string[] = [];
  const q = new ClipboardSyncQueue(
    f.extensions,
    {
      readText: () => "",
      writeText: (s) => {
        writes.push(s);
        return write.promise;
      },
    },
    0,
  );
  await q.flush();
  f.source.emit("clipboard", "issued", f.permit());
  f.source.emit("clipboard", "queued", f.permit());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(writes, ["issued"]);
  let drained = false;
  const drain = q.flush().then(() => {
    drained = true;
  });
  f.revoke();
  await new Promise((r) => setImmediate(r));
  assert.equal(drained, false);
  write.resolve();
  await drain;
  assert.deepEqual(writes, ["issued"]);
  q.stop();
});

test("outbound clipboard read captures authorization before awaiting the backend", async () => {
  const f = fixture(),
    read = deferred<string>();
  let first = true;
  const q = new ClipboardSyncQueue(
    f.extensions,
    {
      readText: () => (first ? ((first = false), "baseline") : read.promise),
      writeText: () => {},
    },
    0,
  );
  await q.flush();
  const poll = q.poll();
  await new Promise((r) => setImmediate(r));
  f.revoke();
  read.resolve("old copied text");
  await poll;
  assert.deepEqual(f.sent, []);
  q.stop();
});

test("disposing a queue discards valid queued writes without starting new OS operations", async () => {
  const f = fixture(),
    baseline = deferred<string>();
  const writes: string[] = [];
  const q = new ClipboardSyncQueue(
    f.extensions,
    {
      readText: () => baseline.promise,
      writeText: (text) => {
        writes.push(text);
      },
    },
    0,
  );
  f.source.emit("clipboard", "queued before disposal", f.permit());
  q.stop();
  baseline.resolve("initial");
  await q.flush();
  await q.poll();
  assert.deepEqual(writes, []);
  assert.deepEqual(f.sent, []);
  assert.equal(f.source.listenerCount("clipboard"), 0);
});
