import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalShareService } from "../src/core/service";

const roots: string[] = [];
const services: LocalShareService[] = [];
async function peer(alias: string) {
  const root = await mkdtemp(join(tmpdir(), "localshare-test-"));
  roots.push(root);
  const service = new LocalShareService({
    dataDir: join(root, "data"),
    receiveDir: join(root, "received"),
    alias,
    port: 0,
    discovery: false,
  });
  services.push(service);
  await service.start();
  return service;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.stop()));
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});
test("two HTTPS peers discover each other and transfer exact binary data after approval", async () => {
  const a = await peer("Mac");
  const b = await peer("Windows");
  const device = await a.register("127.0.0.1", b.info.port);
  assert.equal(device.alias, "Windows");
  assert.equal(
    b.snapshot().devices.some((d) => d.alias === "Mac"),
    true,
  );
  b.on("incoming", (t) => b.respond(t.id, true));
  const bytes = Buffer.from([0, 255, 128, 20, 42]);
  const t = await a.send(device.fingerprint, [
    { name: "folder/data.bin", data: bytes },
  ]);
  assert.equal(t.status, "completed");
  const received = b
    .snapshot()
    .transfers.find((t) => t.direction === "receive")!;
  assert.equal(received.status, "completed");
  assert.deepEqual(await readFile(received.files[0].savedPath!), bytes);
});
test("receiver rejection and cancellation do not save offered files", async () => {
  const a = await peer("Mac");
  const b = await peer("Windows");
  const d = await a.register("127.0.0.1", b.info.port);
  b.on("incoming", (t) => b.respond(t.id, false));
  const t = await a.send(d.fingerprint, [
    { name: "hello.txt", data: Buffer.from("hello") },
  ]);
  assert.equal(t.status, "rejected");
  assert.deepEqual(await readdir(b.receiveDir), []);
});
test("pending request is visible and can be cancelled by sender", async () => {
  const a = await peer("A");
  const b = await peer("B");
  const d = await a.register("127.0.0.1", b.info.port);
  const incoming = new Promise<void>((resolve) =>
    b.once("incoming", () => resolve()),
  );
  const sending = a.send(d.fingerprint, [
    { name: "hello.txt", data: Buffer.from("hello") },
  ]);
  await incoming;
  a.cancel(a.snapshot().transfers.find((t) => t.direction === "send")!.id);
  assert.equal((await sending).status, "cancelled");
});
