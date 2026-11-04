import { test } from "node:test";
import assert from "node:assert/strict";
import { NativeCommands } from "../src/main/native-commands";
test("native capture waits for the matching acknowledgement and fails closed on timeout", async () => {
  const commands: Record<string, unknown>[] = [];
  const channel = new NativeCommands((command) => commands.push(command), 30);
  let done = false;
  const capture = channel.request({ cmd: "capture" }, "captured").then(() => {
    done = true;
  });
  assert.equal(done, false);
  assert.equal(
    channel.accept({ type: "receiving", requestId: commands[0].requestId }),
    false,
  );
  assert.equal(
    channel.accept({ type: "captured", requestId: "stale-request" }),
    false,
  );
  assert.equal(done, false);
  assert.equal(
    channel.accept({ type: "captured", requestId: commands[0].requestId }),
    true,
  );
  await capture;
  assert.equal(done, true);
  assert.equal(commands[0].cmd, "capture");
  assert.equal(typeof commands[0].requestId, "string");
  await assert.rejects(
    channel.request({ cmd: "receive" }, "receiving"),
    /确认超时/,
  );
});
test("a helper fault rejects pending activation immediately", async () => {
  const channel = new NativeCommands(() => {}, 1000);
  const capture = channel.request({ cmd: "capture" }, "captured");
  channel.fail(new Error("权限丢失"));
  await assert.rejects(capture, /权限丢失/);
  assert.equal(channel.accept({ type: "captured" }), false);
});
