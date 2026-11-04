import { test } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import net from "node:net";
import { makePeer } from "./helpers";
import { request, closeConnections } from "../src/core/transport";
test("shutdown closes connections that have not completed a TLS request", async () => {
  const peer = await makePeer("shutdown");
  const socket = net.connect(peer.service.info.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const stopping = peer.service.stop();
  try {
    const closed = await Promise.race([
      stopping.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    assert.equal(
      closed,
      true,
      "an idle handshake must not block application shutdown",
    );
  } finally {
    socket.destroy();
    await stopping;
    await peer.close();
  }
});

test("control requests reuse a pinned TLS connection and cannot reuse it for a different fingerprint", async () => {
  const a = await makePeer("A");
  const b = await makePeer("B");
  let handshakes = 0;
  const sockets = new Set();
  let requests = 0;
  const server = https.createServer(
    { cert: b.service.identity.cert, key: b.service.identity.key },
    (_req, res) => {
      sockets.add(_req.socket);
      requests++;
      res.end("{}");
    },
  );
  server.on("secureConnection", () => handshakes++);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = {
    ip: "127.0.0.1",
    port: (server.address() as { port: number }).port,
    protocol: "https" as const,
    fingerprint: b.service.info.fingerprint,
  };
  try {
    for (let i = 0; i < 8; i++)
      assert.equal(
        (
          await request(a.service.identity, endpoint, "/input", {
            json: {},
            keepAlive: true,
          })
        ).status,
        200,
      );
    assert.equal(handshakes, 1);
    await assert.rejects(
      request(
        a.service.identity,
        { ...endpoint, fingerprint: "0".repeat(64) },
        "/input",
        { json: {}, keepAlive: true },
      ),
      /指纹不匹配/,
    );
    assert.equal(requests, 8);
    closeConnections(a.service.identity.fingerprint);
    await request(a.service.identity, endpoint, "/input", {
      json: {},
      keepAlive: true,
    });
    assert.equal(sockets.size, 2);
  } finally {
    closeConnections(a.service.identity.fingerprint);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await a.close();
    await b.close();
  }
});
