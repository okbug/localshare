import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
const require = createRequire(resolve("package.json"));
const { buildSync } = require("esbuild") as typeof import("esbuild");
const compiled = buildSync({
  entryPoints: ["src/main/native.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  external: ["electron", "../core/control", "../core/extensions"],
}).outputFiles[0].text;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const children: FakeChild[] = [],
    commands: Record<string, unknown>[] = [],
    recoveryCalls: string[][] = [];
  let releaseAck = true,
    heartbeatAck = true,
    recoveryOK = true,
    controlEnabled = true,
    stopped = 0,
    sharingStopped = 0;
  class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: string | null = null;
    killed = false;
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    constructor() {
      super();
      children.push(this);
      this.stdin.on("data", (chunk) => {
        for (const line of String(chunk).trim().split("\n")) {
          const command = JSON.parse(line);
          commands.push(command);
          let type =
            command.cmd === "capture"
              ? "captured"
              : command.cmd === "receive"
                ? "receiving"
                : undefined;
          let id = command.requestId;
          if (["release", "recover"].includes(command.cmd) && releaseAck)
            type = "released";
          if (
            command.cmd === "heartbeat" &&
            command.releaseRequestId &&
            heartbeatAck
          ) {
            type = "released";
            id = command.releaseRequestId;
          }
          if (type)
            setImmediate(() =>
              this.stdout.write(
                JSON.stringify({ type, requestId: id, ok: true }) + "\n",
              ),
            );
        }
      });
      this.stdin.on("finish", () => {
        this.exitCode = 0;
        this.emit("exit", 0);
      });
      setImmediate(() =>
        this.stdout.write(
          '{"type":"ready","permission":true,"protocolVersion":5}\n',
        ),
      );
    }
    kill(signal = "SIGTERM") {
      this.killed = true;
      this.signalCode = signal;
      this.emit("exit", null, signal);
      return true;
    }
  }
  const control = Object.assign(new EventEmitter(), {
    mode: "local",
    input: undefined as any,
    stop: async () => {
      stopped++;
    },
    stopSharing: async () => {
      sharingStopped++;
    },
    push: () => {},
  });
  const extensions = Object.assign(new EventEmitter(), {
    snapshot: () => ({ clipboardEnabled: false, controlEnabled }),
    controlPeer: () => ({ fingerprint: "paired-peer" }),
    setSettings: async (_clipboard: boolean, input: boolean) => {
      controlEnabled = input;
    },
  });
  const childProcess = {
    spawn: () => new FakeChild(),
    execFile: (
      _file: string,
      args: string[],
      _options: unknown,
      callback: any,
    ) => {
      if (args[0] === "--recover-pointer") {
        recoveryCalls.push(args);
        setImmediate(() =>
          callback(
            null,
            JSON.stringify({
              type: "recovered",
              protocolVersion: 5,
              ok: recoveryOK,
            }),
          ),
        );
      } else
        setImmediate(() =>
          callback(null, '{"permission":true,"protocolVersion":5}'),
        );
    },
  };
  const module = { exports: {} as any };
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: (name: string) =>
      name === "electron"
        ? {
            app: {
              isPackaged: false,
              getAppPath: () => "/tmp/localshare-test",
            },
            shell: { openExternal: async () => {} },
          }
        : name === "node:child_process"
          ? childProcess
          : name === "node:fs"
            ? { existsSync: () => true }
            : name === "../core/control"
              ? { validInput: () => false }
              : require(name),
    __dirname: "/tmp/main",
    process: { platform: "darwin", resourcesPath: "/tmp" },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
  });
  const native = new module.exports.NativeInput(control, extensions);
  return {
    native,
    control,
    children,
    commands,
    recoveryCalls,
    stopCount: () => stopped,
    sharingStopCount: () => sharingStopped,
    enabled: () => controlEnabled,
    loseRelease: () => {
      releaseAck = false;
    },
    loseAll: () => {
      releaseAck = false;
      heartbeatAck = false;
    },
    failRecovery: () => {
      recoveryOK = false;
    },
    allowRecovery: () => {
      recoveryOK = true;
    },
  };
}

test("native bridge idle heartbeats are inactive and idle heartbeat can confirm lost release command ACK", async () => {
  const f = fixture();
  await f.native.start();
  await new Promise((resolve) => setTimeout(resolve, 420));
  assert.equal(f.commands.find((c) => c.cmd === "heartbeat")?.active, false);
  await f.control.input.capture();
  f.loseRelease();
  const release = f.native.releaseInput();
  assert.equal(f.native.state.recovering, true);
  await release;
  assert.equal(f.native.state.recovering, false);
  assert.equal(f.recoveryCalls.length, 0);
  assert.ok(
    f.commands.some(
      (c) =>
        c.cmd === "heartbeat" &&
        c.active === false &&
        typeof c.releaseRequestId === "string",
    ),
  );
  await f.native.stop();
});

test("native bridge lost ACK fallback verifies detached recovery and preserves failure until retry", async () => {
  const f = fixture();
  await f.native.start();
  await f.control.input.capture();
  f.loseAll();
  f.failRecovery();
  await assert.rejects(f.native.releaseInput(), /恢复/);
  assert.equal(f.native.state.recoveryFailed, true);
  assert.equal(f.enabled(), false);
  assert.equal(f.recoveryCalls.length, 1);
  await assert.rejects(f.control.input.capture(), /恢复/);
  f.allowRecovery();
  await f.native.recoverPointer();
  assert.equal(f.native.state.recoveryFailed, false);
  assert.equal(f.recoveryCalls.length, 2);
  await f.native.stop();
});

test("native bridge stale child callbacks cannot stop a replacement and idle recovery never spawns a process", async () => {
  const f = fixture();
  await f.native.recoverPointer();
  assert.equal(f.recoveryCalls.length, 0);
  await f.native.start();
  const old = f.children[0];
  await f.native.stop();
  await f.native.start();
  const stopped = f.stopCount();
  old.stdout.write('{"type":"emergency"}\n');
  old.emit("exit", 0);
  await tick();
  assert.equal(f.stopCount(), stopped);
  await f.control.input.capture();
  await f.native.releaseInput();
  await f.native.recoverPointer();
  const enabledBefore = f.commands.filter((c) => c.cmd === "enable").length;
  await f.native.start();
  assert.equal(
    f.commands.filter((c) => c.cmd === "enable").length,
    enabledBefore + 1,
  );
  await f.native.stop();
});

test("native bridge unexpected owned child exit performs detached recovery before allowing activation", async () => {
  const f = fixture();
  await f.native.start();
  await f.control.input.capture();
  const child = f.children[0];
  child.exitCode = 1;
  child.emit("exit", 1);
  assert.equal(f.native.state.recovering, true);
  await f.native.releaseInput();
  assert.equal(f.recoveryCalls.length, 1);
  assert.equal(f.enabled(), false);
  assert.equal(f.native.state.recoveryFailed, false);
  await f.native.stop();
});

test("native bridge capture canceled before its first await cannot pin the cursor later", async () => {
  const f = fixture();
  await f.native.start();
  const capture = f.control.input.capture();
  await f.native.releaseInput();
  await assert.rejects(capture, /取消/);
  assert.equal(f.commands.filter((c) => c.cmd === "capture").length, 0);
  await f.native.stop();
});

test("native local emergency explicitly recovers and disables sharing; active emergency still stops sharing", async (t) => {
  const f = fixture();
  t.after(() => f.native.stop());
  await f.native.start();
  await f.control.input.capture();
  f.children[0].stdout.write('{"type":"emergency"}\n');
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(f.commands.filter((c) => c.cmd === "recover").length, 1);
  assert.equal(f.sharingStopCount(), 0);
  assert.equal(f.enabled(), false);
  assert.equal(
    f.commands.filter((c) => c.cmd === "enable").at(-1)?.left,
    false,
  );
  assert.equal(
    f.native.state.error,
    "已恢复本机鼠标，键鼠共享已关闭，请按需重新开启",
  );
  f.control.mode = "sending";
  f.children[0].stdout.write('{"type":"emergency"}\n');
  await tick();
  assert.equal(f.sharingStopCount(), 1);
  assert.equal(f.commands.filter((c) => c.cmd === "recover").length, 1);
  await f.native.stop();
});

test("native configure suppresses edge permissions when the global sharing switch is off", async (t) => {
  const f = fixture();
  t.after(() => f.native.stop());
  await f.native.start();
  assert.equal(f.commands.filter((c) => c.cmd === "enable").at(-1)?.left, true);
  await f.native.recoverPointer();
  f.native.configure();
  const config = f.commands.filter((c) => c.cmd === "enable").at(-1)!;
  assert.equal(config.left, false);
  assert.equal(config.right, false);
});
