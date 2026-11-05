import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Tray,
  Menu,
  nativeImage,
  Notification,
  globalShortcut,
  session,
  clipboard,
} from "electron";
import { readFile, lstat } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { LocalShareService } from "../core/service";
import { Extensions } from "../core/extensions";
import { Control } from "../core/control";
import { collectSources, atomicJSON } from "../core/files";
import { NativeInput } from "./native";
import { ClipboardSync } from "./clipboard";
import { ControlPanel } from "./control-panel";
import { PanelRecoveryView } from "../shared/panel-recovery";
import { boundedShutdown } from "./shutdown-deadline";
import type {
  DesktopSnapshot,
  Source,
  Selection,
  TrustedPeer,
  ControlPanelState,
} from "../shared/types";

if (process.env.LOCALSHARE_DATA_DIR)
  app.setPath("userData", resolve(process.env.LOCALSHARE_DATA_DIR));
app.setName("LocalShare");
let window: BrowserWindow | undefined,
  tray: Tray | undefined,
  quitting = false,
  service: LocalShareService,
  extensions: Extensions,
  control: Control,
  native: NativeInput,
  clipboardSync: ClipboardSync;
let controlPanel: ControlPanel | undefined;
const recoveryView = new PanelRecoveryView(() => ({
  sessionId: randomUUID(),
  peer: "本机输入",
  direction: "sending",
  clipboard: false,
  shortcut:
    process.platform === "darwin" ? "Control+Option+Esc" : "Ctrl+Alt+Esc",
}));
function notifyControl(title: string, body: string) {
  try {
    if (!quitting && Notification.isSupported())
      new Notification({ title, body }).show();
  } catch {
    /* An optional OS notification must not interrupt input release. */
  }
}
const selection = new Map<string, Source & Selection>();
const devURL = process.env.LOCALSHARE_DEV_URL;
const settingsPath = join(app.getPath("userData"), "settings.json");
let settings: { alias: string; receiveDir: string } = {
  alias: hostname().replace(/\.local$/, ""),
  receiveDir: join(app.getPath("downloads"), "LocalShare"),
};
const sendStates = () => {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
    window.webContents.send("localshare:state", snapshot());
};
const snapshot = (): DesktopSnapshot => ({
  ...service.snapshot(),
  selection: [...selection.values()].map(({ id, name, size }) => ({
    id,
    name,
    size,
  })),
  native: native.state,
});
function panelState(): ControlPanelState | null {
  const state = extensions.snapshot(),
    current = state.control;
  const recovering = native.state.recovering || native.state.recoveryFailed;
  if (
    current.mode === "local" ||
    !current.id ||
    (!recovering && current.interaction !== "manual") ||
    !/^[A-Za-z0-9-]{1,100}$/.test(current.id)
  )
    return recoveryView.select(null, native.state);
  const peer = state.trusted.find((p) => p.fingerprint === current.fingerprint);
  return recoveryView.select(
    {
      sessionId: current.id,
      peer: current.peer ?? peer?.alias ?? "对方设备",
      direction: current.mode,
      clipboard: state.clipboardEnabled && peer?.clipboard === true,
      shortcut:
        process.platform === "darwin" ? "Control+Option+Esc" : "Ctrl+Alt+Esc",
    },
    native.state,
  );
}
async function stopOrRecover(sessionId?: string): Promise<void> {
  if (control.mode !== "local") await control.stopSharing(sessionId);
  else if (
    sessionId === undefined ||
    native.state.recovering ||
    native.state.recoveryFailed
  ) {
    if (native.state.recoveryFailed) show();
    await native.recoverPointer();
  }
}
let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    sendStates();
  }, 80);
}
function show() {
  if (window) {
    window.show();
    window.focus();
  } else void createWindow();
}
function trayImage() {
  const width = 22,
    pixels = Buffer.alloc(width * width * 4);
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const distance = Math.hypot(x - 10.5, y - 10.5);
      if (
        (distance > 7 && distance < 8.6) ||
        (distance > 3.5 && distance < 5) ||
        distance < 1.6
      ) {
        const i = (y * width + x) * 4;
        pixels[i] = 30;
        pixels[i + 1] = 70;
        pixels[i + 2] = 52;
        pixels[i + 3] = 255;
      }
    }
  const image = nativeImage.createFromBitmap(pixels, {
    width,
    height: width,
    scaleFactor: 1,
  });
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1160,
    height: 850,
    minWidth: 800,
    minHeight: 650,
    title: "LocalShare",
    backgroundColor: "#f8faf9",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 20, y: 23 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window?.webContents.getURL()) event.preventDefault();
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  if (devURL) {
    if (devURL !== "http://127.0.0.1:5173") throw new Error("不允许的开发地址");
    await window.loadURL(devURL);
  } else await window.loadFile(join(__dirname, "../renderer/index.html"));
}
function string(v: unknown, max = 256) {
  if (typeof v !== "string" || v.length > max) throw new Error("参数无效");
  return v;
}
function boolean(v: unknown) {
  if (typeof v !== "boolean") throw new Error("参数无效");
  return v;
}
async function addPaths(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some((p) => typeof p !== "string" || !isAbsolute(p))
  )
    throw new Error("文件路径无效");
  const sources = await collectSources(value);
  if (selection.size + sources.length > 10000)
    throw new Error("一次最多选择 10000 个文件");
  for (const source of sources) {
    if ([...selection.values()].some((s) => s.path === source.path)) continue;
    const size = (await lstat(source.path!)).size;
    const id = randomUUID();
    selection.set(id, { ...source, id, size });
  }
  broadcast();
}
async function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", show);
  await app.whenReady();
  if (devURL && devURL !== "http://127.0.0.1:5173")
    throw new Error("不允许的开发地址");
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) =>
    cb(false),
  );
  try {
    settings = {
      ...settings,
      ...JSON.parse(await readFile(settingsPath, "utf8")),
    };
  } catch {}
  const port = Number(process.env.LOCALSHARE_PORT ?? 53317);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("LOCALSHARE_PORT 必须是 0–65535");
  service = new LocalShareService({
    dataDir: app.getPath("userData"),
    receiveDir: process.env.LOCALSHARE_RECEIVE_DIR ?? settings.receiveDir,
    alias: process.env.LOCALSHARE_ALIAS ?? settings.alias,
    port,
    discovery: process.env.LOCALSHARE_NO_DISCOVERY !== "1",
  });
  await service.start();
  extensions = new Extensions(service);
  await extensions.start();
  control = new Control(extensions);
  native = new NativeInput(control, extensions);
  if (process.platform === "win32")
    extensions.displayProvider = () => native.readLayout();
  clipboardSync = new ClipboardSync(extensions);
  control.flushClipboard = () => clipboardSync.flush();
  controlPanel = new ControlPanel({
    getState: panelState,
    onStop: (id) => stopOrRecover(id),
    devURL,
    onError: () => {
      notifyControl(
        "控制窗口出现异常",
        "已尝试恢复本机控制；也可使用紧急停止快捷键。",
      );
    },
  });
  service.on("change", () => {
    native.configure();
    controlPanel?.sync();
    broadcast();
  });
  native.on("change", () => {
    controlPanel?.sync();
    broadcast();
  });
  service.on("incoming", (t) => {
    if (Notification.isSupported())
      new Notification({
        title: "新的传输请求",
        body: `${t.peer} 想发送 ${t.files.length} 个文件`,
      })
        .on("click", show)
        .show();
    show();
  });
  extensions.on("pairing", () => show());
  extensions.on("notice", (message: unknown) => {
    if (
      !quitting &&
      typeof message === "string" &&
      message.startsWith("键鼠") &&
      Notification.isSupported()
    )
      notifyControl("LocalShare", message.slice(0, 400));
  });
  await native.check();
  const methods: Record<string, (...args: any[]) => unknown> = {
    snapshot,
    copyText: (value: unknown) =>
      clipboard.writeText(string(value, 1024 * 1024)),
    selectFiles: async (folder?: boolean) => {
      if (folder !== undefined && typeof folder !== "boolean")
        throw new Error("参数无效");
      const result = await dialog.showOpenDialog(window!, {
        title: folder ? "选择文件夹" : "选择文件",
        properties: folder
          ? ["openDirectory", "multiSelections"]
          : ["openFile", "multiSelections"],
      });
      if (!result.canceled) await addPaths(result.filePaths);
    },
    addDropped: addPaths,
    removeSelection: (id?: unknown) => {
      if (id === undefined) selection.clear();
      else selection.delete(string(id));
      broadcast();
    },
    send: async (fp: unknown, text?: unknown, pin?: unknown) => {
      const target = string(fp, 128);
      const source: Source[] =
        text === undefined
          ? [...selection.values()].map(({ name, path }) => ({ name, path }))
          : [
              {
                name: `文字-${Date.now()}.txt`,
                data: Buffer.from(string(text, 1024 * 1024)),
              },
            ];
      const result = await service.send(
        target,
        source,
        pin === undefined ? undefined : string(pin, 128),
      );
      if (["failed", "rejected"].includes(result.status))
        throw new Error(result.error ?? "传输未完成");
    },
    respond: (id: unknown, yes: unknown) =>
      service.respond(string(id), boolean(yes)),
    cancel: (id: unknown) => service.cancel(string(id)),
    discover: () => service.discover(),
    register: (ip: unknown, port: unknown, protocol: unknown) => {
      if (
        typeof port !== "number" ||
        (protocol !== "http" && protocol !== "https")
      )
        throw new Error("连接信息无效");
      return service.register(string(ip, 100), port, protocol).then(() => {});
    },
    settings: async (alias: unknown) => {
      service.updateAlias(string(alias, 100));
      settings.alias = service.info.alias;
      await atomicJSON(settingsPath, settings);
    },
    chooseReceiveDir: async () => {
      const result = await dialog.showOpenDialog(window!, {
        properties: ["openDirectory", "createDirectory"],
        defaultPath: service.receiveDir,
      });
      if (!result.canceled && result.filePaths[0]) {
        await service.updateReceiveDir(result.filePaths[0]);
        settings.receiveDir = service.receiveDir;
        await atomicJSON(settingsPath, settings);
      }
    },
    openReceiveDir: async () => {
      const error = await shell.openPath(service.receiveDir);
      if (error) throw new Error(error);
    },
    revealFile: (id: unknown, fileId: unknown) => {
      const t = service.snapshot().transfers.find((t) => t.id === string(id));
      const f = t?.files.find((f) => f.id === string(fileId));
      if (!f?.savedPath) throw new Error("没有已接收的文件");
      shell.showItemInFolder(f.savedPath);
    },
    clearHistory: () => service.clearHistory(),
    pair: (fp: unknown) => {
      void extensions.pair(string(fp, 128)).catch((error) => {
        dialog.showErrorBox("配对未完成", error.message);
      });
    },
    respondPair: (id: unknown, yes: unknown) =>
      extensions.respondPair(string(id), boolean(yes)),
    unpair: (fp: unknown) => extensions.unpair(string(fp, 128)),
    peerSettings: (fp: unknown, patch: unknown) => {
      if (
        !patch ||
        typeof patch !== "object" ||
        Array.isArray(patch) ||
        Object.keys(patch).some(
          (k) =>
            ![
              "clipboard",
              "control",
              "side",
              "invertScroll",
              "swapAltWin",
              "entryDisplay",
            ].includes(k),
        )
      )
        throw new Error("设备设置无效");
      return extensions.setPeer(string(fp, 128), patch as Partial<TrustedPeer>);
    },
    extensionSettings: async (clip: unknown, input: unknown) => {
      const c = boolean(clip),
        i = boolean(input);
      if (i) await native.start();
      else await native.stop();
      await extensions.setSettings(c, i);
      native.configure();
    },
    requestPermission: () => native.check(true),
    emergencyStop: () => stopOrRecover(),
    refreshDisplays: (fp: unknown) =>
      extensions.fetchDisplayLayout(string(fp, 128)),
    controlDevice: async (fp: unknown) => {
      const target = string(fp, 128);
      if (!extensions.canControl(target))
        throw new Error(
          "请先开启本机键鼠总开关，并打开对方设备卡片里的「共享键鼠」。两端都需要允许共享。",
        );
      await native.start();
      await control.start(target, "right", 0.5, "manual");
    },
  };
  ipcMain.handle(
    "localshare:call",
    (event, method: unknown, ...args: unknown[]) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("不允许的访问来源");
      const url = event.senderFrame?.url ?? "";
      if (devURL ? url !== `${devURL}/` : !url.startsWith("file://"))
        throw new Error("不允许的页面来源");
      if (
        typeof method !== "string" ||
        !Object.hasOwn(methods, method) ||
        args.length > 4
      )
        throw new Error("未知操作");
      return methods[method](...args);
    },
  );
  tray = new Tray(trayImage());
  tray.setToolTip("LocalShare · 局域网共享");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 LocalShare", click: show },
      {
        label: "停止当前键鼠与文本共享",
        click: () => void stopOrRecover().catch(() => {}),
      },
      { type: "separator" },
      { label: "退出 LocalShare", click: () => app.quit() },
    ]),
  );
  tray.on("click", show);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "LocalShare",
        submenu: [
          { label: "关于 LocalShare", role: "about" },
          { type: "separator" },
          { label: "退出 LocalShare", role: "quit" },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "窗口",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          { label: "显示 LocalShare", click: show },
        ],
      },
    ]),
  );
  globalShortcut.register(
    "Control+Alt+Escape",
    () => void stopOrRecover().catch(() => {}),
  );
  await createWindow();
  app.on("activate", show);
}
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  clearTimeout(broadcastTimer);
  const stopSharing = control?.stopSharing();
  controlPanel?.destroy();
  clipboardSync?.stop();
  const nativeStop = native?.stop();
  globalShortcut.unregisterAll();
  void boundedShutdown(
    async () => {
      await Promise.allSettled([stopSharing, nativeStop]);
      await control?.dispose();
      await extensions?.stop();
      await service?.stop();
    },
    () => {
      try {
        tray?.destroy();
      } finally {
        app.quit();
      }
    },
  );
});
void main().catch(async (error) => {
  quitting = true;
  console.error("LocalShare startup:", error);
  dialog.showErrorBox(
    "LocalShare 无法启动",
    error.code === "EADDRINUSE"
      ? "53317 端口已被占用。请关闭本机的 LocalSend，或设置 LOCALSHARE_PORT 使用其他端口。"
      : error.message,
  );
  await service?.stop();
  app.quit();
});
