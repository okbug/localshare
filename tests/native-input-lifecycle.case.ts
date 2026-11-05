import { test } from "node:test";
import assert from "node:assert/strict";
import { NativeCommands } from "../src/main/native-commands";
import { NativeInputLifecycle } from "../src/main/native-input-lifecycle";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const owner = {},
    other = {};
  const calls: {
    owner: object;
    command: string;
    id?: string;
    pending: ReturnType<typeof deferred>;
  }[] = [];
  const live = new Set([owner, other]);
  const terminated: object[] = [];
  let recovered = 0,
    disabled = 0;
  let recoveryError: Error | undefined;
  let disableError = false;
  const lifecycle = new NativeInputLifecycle<object>({
    request: (owner, command, _ack, id) => {
      const pending = deferred();
      calls.push({ owner, command, id, pending });
      return pending.promise;
    },
    cancelActivation: () => {},
    isLive: (owner) => live.has(owner),
    terminate: async (owner) => {
      terminated.push(owner);
      live.delete(owner);
    },
    recoverAfterExit: async () => {
      recovered++;
      if (recoveryError) throw recoveryError;
    },
    disable: () => {
      disabled++;
      if (disableError) throw new Error("settings listener failed");
    },
    changed: () => {},
  });
  lifecycle.attach(owner);
  return {
    lifecycle,
    owner,
    other,
    calls,
    live,
    terminated,
    recovered: () => recovered,
    disabled: () => disabled,
    failDisable: () => {
      disableError = true;
    },
    failRecovery: () => {
      recoveryError = new Error("recovery refused");
    },
  };
}
async function activate(f: ReturnType<typeof fixture>) {
  const task = f.lifecycle.activate(f.owner, "capture", "captured");
  await tick();
  f.calls.at(-1)!.pending.resolve();
  await task;
}

test("release acknowledgements require exact ID and true success", async () => {
  const writes: Record<string, unknown>[] = [];
  const c = new NativeCommands((value) => writes.push(value), 30);
  const task = c.request({ cmd: "release" }, "released", "release-id");
  assert.equal(writes[0].requestId, "release-id");
  assert.equal(
    c.accept({ type: "released", requestId: "wrong", ok: true }),
    false,
  );
  assert.equal(c.accept({ type: "released", requestId: "release-id" }), false);
  assert.equal(
    c.accept({ type: "released", requestId: "release-id", ok: true }),
    true,
  );
  await task;
  const failed = c.request({ cmd: "recover" }, "released", "failed-id");
  assert.equal(
    c.accept({ type: "released", requestId: "failed-id", ok: false }),
    true,
  );
  await assert.rejects(failed, /释放|恢复/);
});

test("release is one barrier, idle heartbeat echoes ID and activation waits confirmed unlock", async () => {
  const f = fixture();
  assert.equal(f.lifecycle.heartbeat().active, false);
  await activate(f);
  assert.equal(f.lifecycle.heartbeat().active, true);
  const release = f.lifecycle.release();
  assert.equal(f.lifecycle.release(), release);
  await tick();
  assert.equal(f.lifecycle.heartbeat().active, false);
  assert.equal(f.lifecycle.heartbeat().releaseRequestId, f.calls.at(-1)!.id);
  const next = f.lifecycle.activate(f.owner, "receive", "receiving");
  await tick();
  assert.equal(f.calls.length, 2);
  f.calls[1].pending.resolve();
  await release;
  await tick();
  assert.equal(f.calls.length, 3);
  f.calls[2].pending.resolve();
  await next;
  assert.equal(f.recovered(), 0);
  assert.equal(f.lifecycle.recoveryFailed, false);
});

test("missing release ACK terminates owned helper before recovery and disables sharing", async () => {
  const f = fixture();
  await activate(f);
  const release = f.lifecycle.release();
  await tick();
  f.calls.at(-1)!.pending.reject(new Error("ACK timed out"));
  await release;
  assert.deepEqual(f.terminated, [f.owner]);
  assert.equal(f.recovered(), 1);
  assert.equal(f.disabled(), 1);
  assert.equal(f.lifecycle.recovering, false);
  assert.equal(f.lifecycle.recoveryFailed, false);
  assert.equal(f.lifecycle.heartbeat().active, false);
});

test("old child exits cannot stop replacement, while unexpected owned exit recovers", async () => {
  const f = fixture();
  await activate(f);
  const release = f.lifecycle.release();
  await tick();
  f.calls.at(-1)!.pending.resolve();
  await release;
  f.lifecycle.attach(f.other);
  await f.lifecycle.exited(f.owner);
  assert.equal(f.recovered(), 0);
  const task = f.lifecycle.activate(f.other, "capture", "captured");
  await tick();
  f.calls.at(-1)!.pending.resolve();
  await task;
  f.live.delete(f.other);
  await f.lifecycle.exited(f.other);
  assert.equal(f.recovered(), 1);
  assert.equal(f.disabled(), 1);
});

test("failed detached recovery stays failed and blocks capture until explicit successful retry", async () => {
  const f = fixture();
  await activate(f);
  f.failRecovery();
  const release = f.lifecycle.release();
  await tick();
  f.calls.at(-1)!.pending.reject(new Error("lost ACK"));
  await assert.rejects(release, /recovery refused/);
  assert.equal(f.lifecycle.recoveryFailed, true);
  await assert.rejects(
    f.lifecycle.activate(f.owner, "capture", "captured"),
    /恢复/,
  );
  assert.equal(f.lifecycle.heartbeat().active, false);
});

test("explicit recover uses live helper, but never spawns detached recovery while idle and unowned", async () => {
  const f = fixture();
  const recover = f.lifecycle.recover();
  await tick();
  assert.equal(f.calls.at(-1)!.command, "recover");
  f.calls.at(-1)!.pending.resolve();
  await recover;
  assert.equal(f.disabled(), 1);
  assert.equal(f.recovered(), 0);
  f.live.delete(f.owner);
  await f.lifecycle.exited(f.owner);
  await f.lifecycle.recover();
  assert.equal(f.recovered(), 0);
});

test("release arriving before activation starts cancels it without issuing capture", async () => {
  const f = fixture();
  const activation = f.lifecycle.activate(f.owner, "capture", "captured");
  await f.lifecycle.release();
  await assert.rejects(activation, /取消/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.lifecycle.heartbeat().active, false);
  assert.equal(f.recovered(), 0);
});

test("a synchronous settings failure cannot prevent terminating a stuck helper", async () => {
  const f = fixture();
  await activate(f);
  f.failDisable();
  const release = f.lifecycle.release();
  await tick();
  f.calls.at(-1)!.pending.reject(new Error("lost ACK"));
  await release;
  assert.deepEqual(f.terminated, [f.owner]);
  assert.equal(f.recovered(), 1);
});

test("repeated release cancels a newly queued activation while retaining the same unlock barrier", async () => {
  const f = fixture();
  await activate(f);
  const release = f.lifecycle.release();
  await tick();
  const queued = f.lifecycle.activate(f.owner, "receive", "receiving");
  const rejected = assert.rejects(queued, /取消/);
  assert.equal(f.lifecycle.release(), release);
  f.calls.at(-1)!.pending.resolve();
  await release;
  await tick();
  assert.equal(f.calls.length, 2);
  await rejected;
});

test("explicit live recovery still releases when disabling sharing throws synchronously", async () => {
  const f = fixture();
  f.failDisable();
  const task = f.lifecycle.recover();
  await tick();
  assert.equal(f.disabled(), 1);
  assert.equal(f.calls.at(-1)!.command, "recover");
  f.calls.at(-1)!.pending.resolve();
  await task;
  assert.equal(f.lifecycle.recoveryFailed, false);
});
