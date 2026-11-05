import { _electron as electron } from "playwright";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

await mkdir("test-results", { recursive: true });
const root = await mkdtemp(resolve("test-results/control-panel-"));
const packageRoot = process.env.LOCALSHARE_PANEL_ASAR
  ? resolve(process.env.LOCALSHARE_PANEL_ASAR)
  : undefined;
const rendererPath = packageRoot
  ? join(packageRoot, "dist/renderer/index.html")
  : resolve("dist/renderer/index.html");
const preloadPath = packageRoot
  ? join(packageRoot, "dist/preload/control-panel.cjs")
  : resolve("dist/preload/control-panel.cjs");
const ids = [1, 2, 3].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
await writeFile(
  join(root, "probe.cjs"),
  `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('probe',{get:()=>ipcRenderer.invoke('localshare:panel:get'),stop:id=>ipcRenderer.invoke('localshare:panel:stop',id)});`,
);
const entry = join(root, "fixture.ts");
await writeFile(
  entry,
  `import{app,BrowserWindow}from'electron';import{ControlPanel}from${JSON.stringify(resolve("src/main/control-panel.ts"))};
import{makePeer}from${JSON.stringify(resolve("tests/helpers.ts"))};import{Extensions}from${JSON.stringify(resolve("src/core/extensions.ts"))};import{Control}from${JSON.stringify(resolve("src/core/control.ts"))};import{ClipboardSyncQueue}from${JSON.stringify(resolve("src/core/clipboard-sync.ts"))};
app.setPath('userData',${JSON.stringify(join(root, "profile"))});app.setPath('crashDumps',${JSON.stringify(join(root, "crashes"))});
app.whenReady().then(async()=>{
const fixture:any={state:null,stops:[],errors:[]};(globalThis as any).panelFixture=fixture;
fixture.owner=new BrowserWindow({width:800,height:600,webPreferences:{preload:${JSON.stringify(join(root, "probe.cjs"))},contextIsolation:true,sandbox:true}});
await fixture.owner.loadURL('data:text/html,<title>悬浮条测试主窗口</title><p>isolated test</p>');
fixture.manager=new ControlPanel({getState:()=>fixture.real?fixture.view():fixture.state,onStop:async(id)=>{fixture.stops.push(id);if(fixture.real)await fixture.real.ca.stopSharing(id);else if(fixture.state?.sessionId===id)fixture.state=null;fixture.manager.sync()},onError:e=>fixture.errors.push(String(e)),rendererPath:${JSON.stringify(rendererPath)},preloadPath:${JSON.stringify(preloadPath)}});
fixture.connect=async()=>{
 const a=await makePeer('Mac Studio'),b=await makePeer('Windows PC'),ea=new Extensions(a.service),eb=new Extensions(b.service),ca=new Control(ea),cb=new Control(eb);
 const r:any={a,b,ea,eb,ca,cb,av:'A initial',bv:'B initial',writesA:[],writesB:[],releases:0};fixture.real=r;
 fixture.view=()=>{const e=ea.snapshot(),c=e.control;if(c.mode==='local'||!c.id)return null;return{sessionId:c.id,peer:c.peer||'Windows PC',direction:c.mode,clipboard:e.clipboardEnabled&&e.trusted[0]?.clipboard,shortcut:'Control+Option+Esc'}};
 fixture.cleanup=async()=>{r.qa?.stop();r.qb?.stop();await ca.dispose();await cb.dispose();await ea.stop();await eb.stop();await a.close();await b.close()};
 ca.input={capture:async()=>{},receive:async()=>{},inject:()=>{},release:()=>r.releases++};cb.input={capture:async()=>{},receive:async()=>{},inject:()=>{},release:()=>r.releases++};
 await ea.start();await eb.start();const d=await a.service.register('127.0.0.1',b.service.info.port);
 ea.on('pairing',p=>ea.respondPair(p.id,true));eb.on('pairing',p=>eb.respondPair(p.id,true));await ea.pair(d.fingerprint);
 await ea.setSettings(true,true);await eb.setSettings(true,true);await ea.setPeer(d.fingerprint,{control:true,clipboard:true});await eb.setPeer(a.service.info.fingerprint,{control:true,clipboard:true});
 r.qa=new ClipboardSyncQueue(ea,{readText:()=>r.av,writeText:t=>{r.av=t;r.writesA.push(t)}},0);r.qb=new ClipboardSyncQueue(eb,{readText:()=>r.bv,writeText:t=>{r.bv=t;r.writesB.push(t)}},0);ca.flushClipboard=()=>r.qa.flush();cb.flushClipboard=()=>r.qb.flush();
 await r.qa.flush();await r.qb.flush();a.service.on('change',()=>fixture.manager.sync());await ca.start(d.fingerprint,'right',.5,'manual');fixture.manager.sync();
 r.av='shared before stop';await r.qa.poll();await r.qb.flush();return ca.extensions.snapshot().control.id;
};
});`,
);
await build({
  entryPoints: [entry],
  outfile: join(root, "fixture.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (e): e is [string, string] => e[1] !== undefined,
  ),
);
delete env.ELECTRON_RUN_AS_NODE;
delete env.LOCALSHARE_DEV_URL;
const app = await electron.launch({ args: [join(root, "fixture.cjs")], env });
async function until(fn: () => Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("panel state timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function activate(id: string, direction: "sending" | "receiving") {
  await app.evaluate(
    (_, v) => {
      const f = (globalThis as any).panelFixture;
      f.state = {
        sessionId: v.id,
        peer: v.direction === "sending" ? "Windows PC" : "Mac Studio",
        direction: v.direction,
        clipboard: true,
        shortcut: "Control+Option+Esc",
      };
      f.manager.sync();
    },
    { id, direction },
  );
  return currentPanel(id);
}
async function currentPanel(id: string) {
  let page: Awaited<ReturnType<typeof app.firstWindow>> | undefined;
  await until(async () => {
    for (const candidate of app
      .windows()
      .filter((p) => p.url().includes("panel=control"))) {
      try {
        if (
          await candidate.evaluate(
            async (expected) =>
              (await window.controlPanel.snapshot())?.sessionId === expected,
            id,
          )
        ) {
          page = candidate;
          return true;
        }
      } catch {
        /* The previous session's window can still be closing. */
      }
    }
    return false;
  });
  if (!page) throw new Error("current panel not found");
  await page
    .getByRole("button", { name: "停止键鼠与文本共享", exact: true })
    .waitFor({ timeout: 3000 });
  return page;
}
try {
  await until(() =>
    app.evaluate(() => !!(globalThis as any).panelFixture?.manager),
  );
  const owner = await app.firstWindow();
  const rejected = await owner.evaluate(async () => {
    try {
      await (window as any).probe.get();
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(
    rejected,
    true,
    "the main window must not access dedicated panel IPC",
  );
  let panel = await activate(ids[0], "sending");
  await panel.getByText("正在控制 Windows PC", { exact: true }).waitFor();
  await panel.getByText(/对方屏幕/).waitFor();
  assert.equal(
    await panel.evaluate(() => {
      const off = window.controlPanel.subscribe(() => {});
      return typeof (off as () => unknown)();
    }),
    "undefined",
    "unsubscribe must not expose an Electron IPC object",
  );
  const box = await panel.locator(".control-overlay").boundingBox();
  assert.equal(
    box?.x,
    0,
    "panel must not inherit the main window's sidebar margin",
  );
  assert.equal(box?.width, await panel.evaluate(() => window.innerWidth));
  const flags = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes("panel=control"),
    )!;
    return {
      top: p.isAlwaysOnTop(),
      movable: p.isMovable(),
      resizable: p.isResizable(),
      focused: p.isFocused(),
      bounds: p.getBounds(),
    };
  });
  assert.equal(flags.top, true);
  assert.equal(flags.movable, false);
  assert.equal(flags.resizable, false);
  assert.equal(flags.focused, false);
  await app.evaluate(() => {
    (globalThis as any).panelFixture.owner.hide();
  });
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes("panel=control"))
        ?.isVisible(),
    ),
    true,
  );
  await panel.screenshot({ path: "docs/images/control-panel.png" });
  await panel
    .getByRole("button", { name: "停止键鼠与文本共享", exact: true })
    .click();
  await until(() =>
    app.evaluate(() => !(globalThis as any).panelFixture.state),
  );
  panel = await activate(ids[1], "receiving");
  await panel.getByText("Mac Studio 正在控制本机", { exact: true }).waitFor();
  const stale = await panel.evaluate(async (id) => {
    try {
      await window.controlPanel.stop(id);
      return false;
    } catch {
      return true;
    }
  }, ids[0]);
  assert.equal(stale, true);
  assert.equal(
    await app.evaluate(() => (globalThis as any).panelFixture.state.sessionId),
    ids[1],
  );
  await panel
    .getByRole("button", { name: "停止键鼠与文本共享", exact: true })
    .click();
  await until(() =>
    app.evaluate(() => !(globalThis as any).panelFixture.state),
  );
  panel = await activate(ids[2], "receiving");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes("panel=control"))!
      .close(),
  );
  await until(() =>
    app.evaluate(() => !(globalThis as any).panelFixture.state),
  );
  assert.deepEqual(
    await app.evaluate(() => (globalThis as any).panelFixture.stops),
    ids,
  );
  const realId = await app.evaluate(
    async () => await (globalThis as any).panelFixture.connect(),
  );
  panel = await currentPanel(realId);
  assert.equal(
    await app.evaluate(() => (globalThis as any).panelFixture.real.bv),
    "shared before stop",
  );
  await panel
    .getByRole("button", { name: "停止键鼠与文本共享", exact: true })
    .click();
  await until(() =>
    app.evaluate(() => {
      const r = (globalThis as any).panelFixture.real;
      return (
        r.ca.mode === "local" &&
        r.cb.mode === "local" &&
        !r.ea.snapshot().trusted[0].clipboard &&
        !r.eb.snapshot().trusted[0].clipboard
      );
    }),
  );
  const result = await app.evaluate(async () => {
    const r = (globalThis as any).panelFixture.real;
    r.av = "A after stop";
    r.bv = "B after stop";
    await r.qa.poll();
    await r.qb.poll();
    await r.qa.flush();
    await r.qb.flush();
    return {
      av: r.av,
      bv: r.bv,
      releases: r.releases,
      writesA: r.writesA,
      writesB: r.writesB,
    };
  });
  assert.equal(result.av, "A after stop");
  assert.equal(result.bv, "B after stop");
  assert.ok(result.releases >= 2);
  assert.deepEqual(result.writesA, []);
  assert.deepEqual(result.writesB, ["shared before stop"]);
  console.log(
    "PASS: Real fixed Electron panels and restricted IPC; a real button click ends both authenticated HTTPS control sessions and clipboard grants, with no subsequent text delivery. Native input/OS clipboard were simulated.",
  );
} finally {
  await app
    .evaluate(async () => {
      await (globalThis as any).panelFixture?.cleanup?.();
      (globalThis as any).panelFixture?.manager?.destroy();
    })
    .catch(() => {});
  await app.close();
  await rm(root, { recursive: true, force: true });
}
