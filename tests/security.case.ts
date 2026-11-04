import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { safeRelative, receiveFile, collectSources } from "../src/core/files";
import { request, jsonReply } from "../src/core/transport";
import { makePeer } from "./helpers";
const prefix = "/api/localsend/v2";
test("paths reject traversal, drive paths, UNC, control characters and Windows reserved files", () => {
  for (const name of [
    "../escape",
    "/absolute",
    "C:/file",
    "..\\file",
    "a/../../x",
    "a//b",
    "a/./b",
    "NUL.txt",
    "foo/CON",
    "a. ",
    "a\0b",
    "a\nb",
    "a:ads",
    "LPT1",
  ])
    assert.throws(() => safeRelative(name), name);
  assert.equal(safeRelative("项目/你好.txt"), "项目/你好.txt");
});
test("fingerprint mismatch rejects the TLS handshake before metadata reaches receiver", async () => {
  const a = await makePeer("A");
  const b = await makePeer("B");
  try {
    await assert.rejects(
      request(
        a.service.identity,
        {
          ip: "127.0.0.1",
          port: b.service.info.port,
          protocol: "https",
          fingerprint: "0".repeat(64),
        },
        `${prefix}/register`,
        { json: a.service.info },
      ),
      /指纹不匹配/,
    );
    assert.equal(b.service.snapshot().devices.length, 0);
  } finally {
    await a.close();
    await b.close();
  }
});
test("upload verifies checksums, tokens and certificate identity, disallows replay", async () => {
  const a = await makePeer("A");
  const b = await makePeer("B");
  const c = await makePeer("C");
  try {
    const d = await a.service.register("127.0.0.1", b.service.info.port);
    b.service.on("incoming", (t) => b.service.respond(t.id, true));
    const prepare = async (sha256?: string) =>
      jsonReply<{ sessionId: string; files: Record<string, string> }>(
        await request(a.service.identity, d, `${prefix}/prepare-upload`, {
          json: {
            info: a.service.info,
            files: {
              f: {
                id: "f",
                fileName: "ok.txt",
                fileType: "text/plain",
                size: 3,
                sha256,
              },
            },
          },
        }),
      );
    const s = await prepare();
    const path = `${prefix}/upload?${new URLSearchParams({ sessionId: s.sessionId, fileId: "f", token: s.files.f })}`;
    assert.equal(
      (
        await request(c.service.identity, d, path, {
          stream: Readable.from(["abc"]),
          size: 3,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(a.service.identity, d, path.replace(s.files.f, "wrong"), {
          stream: Readable.from(["abc"]),
          size: 3,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(a.service.identity, d, path, {
          stream: Readable.from(["abc"]),
          size: 3,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(a.service.identity, d, path, {
          stream: Readable.from(["abc"]),
          size: 3,
        })
      ).status,
      403,
    );
    const bad = await prepare("0".repeat(64));
    const response = await request(
      a.service.identity,
      d,
      `${prefix}/upload?${new URLSearchParams({ sessionId: bad.sessionId, fileId: "f", token: bad.files.f })}`,
      { stream: Readable.from(["abc"]), size: 3 },
    );
    assert.equal(response.status, 422);
    const failed = b.service
      .snapshot()
      .transfers.find((t) => t.id === bad.sessionId)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.files[0].savedPath, undefined);
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
});
test("unsafe metadata and claimed identity are rejected before approval", async () => {
  const a = await makePeer("A");
  const b = await makePeer("B");
  try {
    const d = await a.service.register("127.0.0.1", b.service.info.port);
    for (const name of ["../outside.txt", "C:/bad", "NUL"]) {
      assert.equal(
        (
          await request(a.service.identity, d, `${prefix}/prepare-upload`, {
            json: {
              info: a.service.info,
              files: {
                f: { id: "f", fileName: name, size: 1, fileType: "text/plain" },
              },
            },
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await request(a.service.identity, d, `${prefix}/register`, {
          json: { ...a.service.info, fingerprint: "0".repeat(64) },
        })
      ).status,
      403,
    );
    assert.equal(b.service.snapshot().transfers.length, 0);
  } finally {
    await a.close();
    await b.close();
  }
});
test("file publication does not overwrite and never follows nested symlinks", async () => {
  const p = await makePeer("A");
  try {
    const receive = (name: string, content: string) =>
      receiveFile({
        root: p.service.receiveDir,
        name,
        stream: Readable.from([content]),
        size: Buffer.byteLength(content),
        signal: new AbortController().signal,
        progress: () => {},
      });
    const first = await receive("a.txt", "one");
    const second = await receive("a.txt", "two");
    assert.notEqual(first, second);
    assert.equal(await readFile(first, "utf8"), "one");
    assert.equal(await readFile(second, "utf8"), "two");
    await mkdir(join(p.root, "outside"));
    await symlink(
      join(p.root, "outside"),
      join(p.service.receiveDir, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(receive("link/escape.txt", "bad"), /符号链接/);
    assert.deepEqual(await readdir(join(p.root, "outside")), []);
    await assert.rejects(
      receiveFile({
        root: p.service.receiveDir,
        name: "partial.txt",
        stream: Readable.from(["short"]),
        size: 100,
        signal: new AbortController().signal,
        progress: () => {},
      }),
      /长度/,
    );
    assert.equal(
      (await readdir(p.service.receiveDir)).some((n) => n.endsWith(".part")),
      false,
    );
  } finally {
    await p.close();
  }
});
test("concurrent prepare requests cannot bypass the four-request queue limit", async () => {
  const a = await makePeer("A"),
    b = await makePeer("B");
  try {
    const d = await a.service.register("127.0.0.1", b.service.info.port);
    const pending: string[] = [];
    b.service.on("incoming", (t) => pending.push(t.id));
    const body = Buffer.from(
      JSON.stringify({
        info: a.service.info,
        files: {
          f: { id: "f", fileName: "file.txt", size: 1, fileType: "text/plain" },
        },
      }),
    );
    const requests = Array.from({ length: 5 }, () => {
      let started = false;
      const stream = new Readable({
        read() {
          if (started) return;
          started = true;
          this.push(body.subarray(0, 10));
          setTimeout(() => {
            this.push(body.subarray(10));
            this.push(null);
          }, 150);
        },
      });
      return request(a.service.identity, d, `${prefix}/prepare-upload`, {
        stream,
        size: body.length,
        headers: { "content-type": "application/json" },
      });
    });
    await new Promise((r) => setTimeout(r, 350));
    const pendingCount = pending.length;
    for (const id of pending) b.service.respond(id, false);
    const responses = await Promise.all(requests);
    assert.equal(pendingCount, 4);
    assert.equal(responses.filter((r) => r.status === 409).length, 1);
  } finally {
    await a.close();
    await b.close();
  }
});
