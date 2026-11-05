import {
  BrowserWindow,
  ipcMain,
  screen,
  type IpcMainInvokeEvent,
} from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ControlPanelState } from "../shared/types";
import { controlPanelBounds } from "../shared/panel-position";

export interface ControlPanelOptions {
  getState: () => ControlPanelState | null;
  onStop: (id: string) => Promise<void>;
  devURL?: string;
  rendererPath?: string;
  preloadPath?: string;
  onError?: (error: unknown) => void;
}

interface PanelBinding {
  window: BrowserWindow;
  sessionId: string;
  expectedClose: boolean;
  loaded: boolean;
  failed: boolean;
}

const getChannel = "localshare:panel:get";
const stopChannel = "localshare:panel:stop";
const stateChannel = "localshare:panel:state";

export class ControlPanel {
  private binding?: PanelBinding;
  private destroyed = false;
  private failedSessionId?: string;
  private readonly expectedURL: string;
  private readonly rendererPath: string;

  constructor(private readonly options: ControlPanelOptions) {
    this.rendererPath =
      options.rendererPath ?? join(__dirname, "../renderer/index.html");
    const url = options.devURL
      ? new URL(options.devURL)
      : pathToFileURL(this.rendererPath);
    url.searchParams.set("panel", "control");
    this.expectedURL = url.toString();
    ipcMain.handle(getChannel, (event) => {
      const binding = this.authorize(event);
      const state = this.options.getState();
      return state?.sessionId === binding.sessionId ? state : null;
    });
    ipcMain.handle(stopChannel, async (event, id: unknown) => {
      const binding = this.authorize(event);
      const state = this.options.getState();
      if (
        typeof id !== "string" ||
        !/^[A-Za-z0-9-]{1,100}$/.test(id) ||
        id !== binding.sessionId ||
        id !== state?.sessionId
      )
        throw new Error("Control panel session is no longer current");
      await this.stopSession(id);
    });
  }

  sync(): void {
    if (this.destroyed) return;
    const state = this.options.getState();
    if (!state) {
      this.failedSessionId = undefined;
      const binding = this.binding;
      if (binding && !binding.window.isDestroyed()) {
        if (binding.loaded) binding.window.webContents.send(stateChannel, null);
        binding.window.hide();
      }
      return;
    }
    if (this.failedSessionId === state.sessionId) return;
    if (this.binding?.sessionId !== state.sessionId) {
      if (this.binding) this.disposeWindow(this.binding);
      try {
        this.create(state);
      } catch (error) {
        this.reportError(error);
        if (this.binding?.sessionId === state.sessionId)
          this.disposeWindow(this.binding);
        this.failedSessionId = state.sessionId;
        if (this.options.getState()?.sessionId === state.sessionId)
          void this.stopSession(state.sessionId).catch(() => {});
      }
      return;
    }
    this.publish(this.binding);
  }

  /** App shutdown: remove IPC and close the window without invoking onStop. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    ipcMain.removeHandler(getChannel);
    ipcMain.removeHandler(stopChannel);
    if (this.binding) this.disposeWindow(this.binding);
  }

  stop(): void {
    this.destroy();
  }

  private authorize(event: IpcMainInvokeEvent): PanelBinding {
    const binding = this.binding;
    if (
      this.destroyed ||
      !binding ||
      binding.failed ||
      binding.window.isDestroyed() ||
      event.sender !== binding.window.webContents ||
      event.senderFrame !== binding.window.webContents.mainFrame ||
      event.senderFrame?.url !== this.expectedURL ||
      binding.window.webContents.getURL() !== this.expectedURL
    )
      throw new Error("Untrusted control panel request");
    return binding;
  }

  private create(state: ControlPanelState): void {
    const display = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    );
    const window = new BrowserWindow({
      ...controlPanelBounds(display.workArea),
      show: false,
      frame: false,
      movable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      acceptFirstMouse: true,
      webPreferences: {
        preload:
          this.options.preloadPath ??
          join(__dirname, "../preload/control-panel.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const binding: PanelBinding = {
      window,
      sessionId: state.sessionId,
      expectedClose: false,
      loaded: false,
      failed: false,
    };
    this.binding = binding;
    window.on("closed", () => this.fail(binding));
    window.webContents.on("render-process-gone", () => this.fail(binding));
    window.webContents.on("did-fail-load", () => this.fail(binding));
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== this.expectedURL) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.setAlwaysOnTop(true, "screen-saver");
    if (process.platform === "darwin")
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const load = this.options.devURL
      ? window.loadURL(this.expectedURL)
      : window.loadFile(this.rendererPath, { query: { panel: "control" } });
    void load
      .then(() => {
        if (binding.expectedClose || binding.failed || this.binding !== binding)
          return;
        binding.loaded = true;
        this.publish(binding);
      })
      .catch((error: unknown) => {
        if (!binding.expectedClose) this.reportError(error);
        this.fail(binding);
      });
  }

  private publish(binding: PanelBinding): void {
    if (!binding.loaded || binding.failed || binding.window.isDestroyed())
      return;
    const state = this.options.getState();
    if (state?.sessionId !== binding.sessionId) return;
    if (
      binding.window.webContents.getURL() !== this.expectedURL ||
      binding.window.webContents.mainFrame.url !== this.expectedURL
    ) {
      this.fail(binding);
      return;
    }
    binding.window.webContents.send(stateChannel, state);
    if (!binding.window.isVisible()) binding.window.showInactive();
  }

  private fail(binding: PanelBinding): void {
    if (binding.expectedClose || binding.failed || this.destroyed) return;
    binding.failed = true;
    this.failedSessionId = binding.sessionId;
    this.disposeWindow(binding);
    if (this.options.getState()?.sessionId === binding.sessionId)
      void this.stopSession(binding.sessionId).catch(() => {});
  }

  private disposeWindow(binding: PanelBinding): void {
    binding.expectedClose = true;
    if (this.binding === binding) this.binding = undefined;
    if (!binding.window.isDestroyed()) binding.window.destroy();
  }

  private async stopSession(id: string): Promise<void> {
    try {
      await this.options.onStop(id);
    } catch (error) {
      this.reportError(error);
      throw error;
    }
  }

  private reportError(error: unknown): void {
    try {
      if (this.options.onError) this.options.onError(error);
      else console.error("Control panel failed:", error);
    } catch {
      // A diagnostic callback must never turn cleanup into an unhandled error.
    }
  }
}
