import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import type { ControlPanelState } from "../src/shared/types";

const require = createRequire(resolve("package.json"));
const { buildSync } = require("esbuild") as typeof import("esbuild");
const compiled = buildSync({
  entryPoints: ["src/main/control-panel.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  external: ["electron"],
}).outputFiles[0].text;
const tick = () => new Promise<void>((done) => setImmediate(done));
function fixture() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const windows: FakeWindow[] = [];
  let state: ControlPanelState | null = {
    sessionId: "session-old",
    peer: "Windows",
    direction: "sending",
    clipboard: true,
    shortcut: "Control+Option+Esc",
  };
  const stopped: string[] = [],
    errors: unknown[] = [];
  let failStop = false;
  class FakeWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: "" },
      getURL: () => this.url,
      send: (...args: unknown[]) => this.sent.push(args),
      setWindowOpenHandler: (_handler: unknown) => {},
    });
    url = "";
    sent: unknown[][] = [];
    visible = false;
    dead = false;
    showCount = 0;
    top: unknown[] = [];
    workspace: unknown[] = [];
    finish!: () => void;
    fail!: (error: Error) => void;
    constructor(public options: any) {
      super();
      windows.push(this);
    }
    loadURL(url: string) {
      this.url = url;
      this.webContents.mainFrame.url = url;
      return new Promise<void>((done, fail) => {
        this.finish = done;
        this.fail = fail;
      });
    }
    loadFile(path: string, options: any) {
      return this.loadURL(`file://${path}?panel=${options.query.panel}`);
    }
    setAlwaysOnTop(...args: unknown[]) {
      this.top = args;
    }
    setVisibleOnAllWorkspaces(...args: unknown[]) {
      this.workspace = args;
    }
    setBounds(bounds: any) {
      this.options = { ...this.options, ...bounds };
    }
    isDestroyed() {
      return this.dead;
    }
    isVisible() {
      return this.visible;
    }
    showInactive() {
      this.visible = true;
      this.showCount++;
    }
    hide() {
      this.visible = false;
    }
    destroy() {
      this.dead = true;
      this.visible = false;
      this.emit("closed");
    }
  }
  const electron = {
    BrowserWindow: FakeWindow,
    ipcMain: {
      handle: (channel: string, handler: any) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    },
    screen: {
      getCursorScreenPoint: () => ({ x: -800, y: 20 }),
      getDisplayNearestPoint: () => ({
        workArea: { x: -1920, y: -100, width: 1920, height: 1080 },
      }),
    },
  };
  const module = { exports: {} as any };
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: (name: string) => (name === "electron" ? electron : require(name)),
    __dirname: "/tmp/localshare/main",
    console,
    process,
    URL,
  });
  const manager = new module.exports.ControlPanel({
    getState: () => state,
    onStop: async (id: string) => {
      stopped.push(id);
      if (failStop) throw new Error("stop failed");
    },
    onError: (error: unknown) => errors.push(error),
    devURL: "http://127.0.0.1:5173/",
    preloadPath: "/tmp/control-panel.cjs",
  });
  const event = (window: FakeWindow) => ({
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  });
  return {
    manager,
    windows,
    handlers,
    stopped,
    errors,
    event,
    setState: (value: ControlPanelState | null) => {
      state = value;
    },
    getState: () => state!,
    failStop: () => {
      failStop = true;
    },
  };
}

test("panel creates fixed inactive window, updates state and hides independently", async () => {
  const f = fixture();
  f.manager.sync();
  assert.equal(f.windows.length, 1);
  const w = f.windows[0];
  w.finish();
  await tick();
  assert.equal(w.visible, true);
  assert.equal(w.url, "http://127.0.0.1:5173/?panel=control");
  for (const flag of [
    "movable",
    "resizable",
    "minimizable",
    "maximizable",
    "frame",
  ])
    assert.equal(w.options[flag], false, flag);
  assert.equal(w.options.skipTaskbar, true);
  assert.equal(w.options.webPreferences.contextIsolation, true);
  assert.equal(w.options.webPreferences.nodeIntegration, false);
  assert.deepEqual(w.top, [true, "screen-saver"]);
  assert.equal(w.options.x, -456);
  assert.equal(w.options.y, -84);
  assert.equal(w.sent.at(-1)?.[0], "localshare:panel:state");
  f.setState({ ...f.getState(), clipboard: false });
  f.manager.sync();
  assert.equal((w.sent.at(-1)?.[1] as ControlPanelState).clipboard, false);
  f.setState(null);
  f.manager.sync();
  assert.equal(w.visible, false);
  assert.deepEqual(f.stopped, []);
  f.manager.destroy();
  assert.equal(w.dead, true);
  assert.equal(f.handlers.size, 0);
});

test("panel IPC permits only its own exact trusted main frame and live bound session", async () => {
  const f = fixture();
  f.manager.sync();
  const w = f.windows[0];
  w.finish();
  await tick();
  const get = f.handlers.get("localshare:panel:get")!,
    stop = f.handlers.get("localshare:panel:stop")!;
  assert.equal((await get(f.event(w))).sessionId, "session-old");
  assert.throws(() => get({ ...f.event(w), sender: {} }), /panel/i);
  assert.throws(
    () => get({ ...f.event(w), senderFrame: { url: w.url } }),
    /panel/i,
  );
  w.webContents.mainFrame.url = "http://127.0.0.1:5173/?panel=control#foreign";
  assert.throws(() => get(f.event(w)), /panel/i);
  w.webContents.mainFrame.url = w.url;
  await assert.rejects(
    async () => stop(f.event(w), "x".repeat(101)),
    /session/i,
  );
  await assert.rejects(async () => stop(f.event(w), "session-new"), /session/i);
  await stop(f.event(w), "session-old");
  assert.deepEqual(f.stopped, ["session-old"]);
  f.setState({ ...f.getState(), sessionId: "session-new" });
  await assert.rejects(async () => stop(f.event(w), "session-old"), /session/i);
  await assert.rejects(async () => stop(f.event(w), "session-new"), /session/i);
  f.manager.destroy();
});

test("panel failures stop only their own live session and shutdown never stops control", async () => {
  for (const failure of ["closed", "render-process-gone", "did-fail-load"]) {
    const f = fixture();
    f.manager.sync();
    const w = f.windows[0];
    (failure === "closed" ? w : w.webContents).emit(failure);
    await tick();
    assert.deepEqual(f.stopped, ["session-old"], failure);
    f.manager.destroy();
  }
  const f = fixture();
  f.manager.sync();
  const old = f.windows[0];
  f.setState({ ...f.getState(), sessionId: "session-new" });
  f.manager.sync();
  old.fail(new Error("late old load failure"));
  old.webContents.emit("render-process-gone");
  await tick();
  assert.deepEqual(f.stopped, []);
  assert.equal(f.windows.length, 2);
  f.manager.stop();
  assert.equal(f.handlers.size, 0);
  assert.deepEqual(f.stopped, []);
});

test("panel stop callback failures are reported without an unhandled rejection", async () => {
  const f = fixture();
  f.failStop();
  f.manager.sync();
  f.windows[0].webContents.emit("render-process-gone");
  await tick();
  assert.equal(f.errors.length, 1);
  f.manager.destroy();
});

test("panel never publishes state after navigation away from its trusted document", async () => {
  const f = fixture();
  f.manager.sync();
  const w = f.windows[0];
  w.finish();
  await tick();
  const updates = w.sent.length;
  w.url = "https://example.invalid/";
  w.webContents.mainFrame.url = w.url;
  f.manager.sync();
  await tick();
  assert.equal(w.sent.length, updates);
  assert.deepEqual(f.stopped, ["session-old"]);
  f.manager.destroy();
});

test("panel load rejection fails closed once and reports the load error", async () => {
  const f = fixture();
  f.manager.sync();
  const w = f.windows[0];
  w.fail(new Error("load failed"));
  await tick();
  assert.deepEqual(f.stopped, ["session-old"]);
  assert.equal(f.errors.length, 1);
  f.manager.sync();
  assert.equal(f.windows.length, 1);
  f.manager.destroy();
});
