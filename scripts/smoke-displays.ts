import { _electron as electron } from "playwright";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

await mkdir("test-results", { recursive: true });
const root = await mkdtemp(resolve("test-results/display-ui-"));
const fp = "A".repeat(64);
const layout = {
  version: 1,
  platform: "windows",
  entrySelection: true,
  displays: [
    {
      id: "DISPLAY2",
      name: "左侧竖屏",
      x: -1080,
      y: -200,
      width: 1080,
      height: 1920,
      primary: false,
    },
    {
      id: "DISPLAY1",
      name: "主屏",
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      primary: true,
    },
  ],
};
const info = {
  alias: "测试 Mac",
  deviceModel: "macOS",
  deviceType: "desktop",
  fingerprint: "B".repeat(64),
  version: "2.2",
  port: 53317,
  protocol: "https",
  localshare: true,
};
const state = {
  info,
  addresses: ["127.0.0.1"],
  devices: [
    {
      ...info,
      alias: "Windows PC",
      deviceModel: "Windows",
      fingerprint: fp,
      ip: "127.0.0.1",
      lastSeen: Date.now(),
    },
  ],
  transfers: [],
  selection: [],
  receiveDir: root,
  native: { available: true, permission: true },
  extensions: {
    trusted: [
      {
        fingerprint: fp,
        alias: "Windows PC",
        clipboard: false,
        control: true,
        side: "right",
        invertScroll: false,
        swapAltWin: false,
        entryDisplay: "",
      },
    ],
    pairing: [],
    clipboardEnabled: false,
    controlEnabled: false,
    control: { mode: "local" },
    displayLayouts: {},
  },
};
await writeFile(join(root, "fixture.json"), JSON.stringify({ state, layout }));
await writeFile(
  join(root, "preload.cjs"),
  `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('localshare',{
snapshot:()=>ipcRenderer.invoke('snapshot'),
subscribe:(fn)=>{const cb=(_,s)=>fn(s);ipcRenderer.on('state',cb);return()=>ipcRenderer.removeListener('state',cb)},
refreshDisplays:(fp)=>ipcRenderer.invoke('refresh',fp),peerSettings:(fp,p)=>ipcRenderer.invoke('peer',fp,p),emergencyStop:async()=>{}});`,
);
await writeFile(
  join(root, "main.cjs"),
  `const{app,BrowserWindow,ipcMain}=require('electron');const path=require('path');const{state,layout}=require('./fixture.json');
app.setPath('userData',path.join(__dirname,'profile'));let window;const publish=()=>window.webContents.send('state',state);
globalThis.fixture=state;
ipcMain.handle('snapshot',()=>state);
ipcMain.handle('refresh',()=>{state.extensions.displayLayouts[${JSON.stringify(fp)}]=layout;publish();return layout});
ipcMain.handle('peer',(_,fp,p)=>{Object.assign(state.extensions.trusted[0],p);publish()});
app.whenReady().then(()=>{window=new BrowserWindow({width:1300,height:1000,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:false}});window.loadFile(${JSON.stringify(resolve("dist/renderer/index.html"))})});`,
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [join(root, "main.cjs")], env });
try {
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "设备协同", exact: false }).click();
  const region = page.getByRole("region", {
    name: "Windows PC 屏幕排列与入口",
  });
  await region.waitFor({ timeout: 3000 });
  await region.getByLabel("Windows PC 进入屏幕").selectOption("DISPLAY2");
  assert.equal(
    (await page.evaluate(() => window.localshare.snapshot())).extensions
      .trusted[0].entryDisplay,
    "DISPLAY2",
  );
  await region.getByText("左侧竖屏", { exact: true }).waitFor();
  await region.getByText("主屏", { exact: true }).first().waitFor();
  await region.getByRole("button", { name: "刷新排列" }).click();
  await region.getByLabel("Windows PC 进入屏幕").selectOption("");
  assert.equal(
    (await page.evaluate(() => window.localshare.snapshot())).extensions
      .trusted[0].entryDisplay,
    "",
  );
  await region.screenshot({ path: "docs/images/display-layout.png" });
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const fixture = (globalThis as any).fixture;
    fixture.extensions.trusted[0].entryDisplay = "DISPLAY2";
    fixture.extensions.displayLayouts = {};
    ipcMain.removeHandler("refresh");
    ipcMain.handle("refresh", () => {
      throw new Error("对方不支持多屏入口设置，请升级对方的 LocalShare");
    });
    BrowserWindow.getAllWindows()[0].webContents.send("state", fixture);
  });
  await region.getByRole("button", { name: "刷新排列" }).click();
  await region.getByText(/对方不支持多屏入口设置/).waitFor();
  await region
    .getByRole("button", { name: "恢复自动入口" })
    .click({ timeout: 3000 });
  await page.waitForFunction(
    async () =>
      (await window.localshare.snapshot()).extensions.trusted[0]
        .entryDisplay === "",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Synthetic multi-monitor layout renders negative-origin portrait/main screens; entry selection/automatic/refresh work through IPC. No physical Windows device used.",
  );
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
