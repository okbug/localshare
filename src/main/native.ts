import { app, shell } from "electron";
import { EventEmitter } from "node:events";
import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Control, validInput } from "../core/control";
import { Extensions } from "../core/extensions";
export class NativeInput extends EventEmitter {
  state = {
    available: false,
    permission: false,
    error: undefined as string | undefined,
  };
  private process?: ChildProcessWithoutNullStreams;
  private heartbeat?: ReturnType<typeof setInterval>;
  private configuration = "";
  private helper = join(
    app.isPackaged
      ? join(process.resourcesPath, "native")
      : join(app.getAppPath(), "native/bin"),
    process.platform === "win32" ? "localshare-input.exe" : "localshare-input",
  );
  constructor(
    private control: Control,
    private extensions: Extensions,
  ) {
    super();
    control.on("capture", () => {
      this.state.error = undefined;
      this.emit("change");
      this.send({ cmd: "capture" });
    });
    control.on("receive", (position) => {
      this.state.error = undefined;
      this.emit("change");
      this.send({ cmd: "receive", ...position });
    });
    control.on("input", (e) => this.send({ cmd: "event", ...e }));
    control.on("release", () => this.send({ cmd: "release" }));
    extensions.on("trustChanged", () => this.configure());
  }
  private send(value: unknown) {
    if (this.process && !this.process.killed && this.process.stdin.writable)
      this.process.stdin.write(`${JSON.stringify(value)}\n`);
  }
  async check(prompt = false) {
    this.state.available = existsSync(this.helper);
    if (!this.state.available) {
      this.state.error = "系统输入模块尚未构建；请先运行 bun run native。";
      this.emit("change");
      return;
    }
    await new Promise<void>((resolve) =>
      execFile(
        this.helper,
        [prompt ? "--request" : "--check"],
        { timeout: 10000, windowsHide: true },
        (err, stdout) => {
          try {
            this.state.permission =
              JSON.parse(stdout.trim()).permission === true;
            this.state.error = err ? "输入模块检查失败" : undefined;
          } catch {
            this.state.error = err?.message ?? "无法读取输入权限状态";
          }
          this.emit("change");
          resolve();
        },
      ),
    );
    if (prompt && process.platform === "darwin" && !this.state.permission)
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
  }
  async start() {
    if (this.process) {
      this.configure();
      return;
    }
    await this.check();
    if (!this.state.permission)
      throw new Error("请先在系统设置中为 LocalShare 输入模块授予辅助功能权限");
    const child = spawn(this.helper, [], { stdio: "pipe", windowsHide: true });
    this.process = child;
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});
    const lines = createInterface({ input: child.stdout });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("输入模块启动超时")),
        5000,
      );
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      lines.on("line", (line) => {
        if (line.length > 32768) return;
        try {
          const e = JSON.parse(line);
          if (e.type === "ready") {
            clearTimeout(timer);
            if (e.permission) resolve();
            else reject(new Error("输入模块没有辅助功能权限"));
          } else if (
            e.type === "edge" &&
            (e.side === "left" || e.side === "right") &&
            typeof e.y === "number" &&
            e.y >= 0 &&
            e.y <= 1
          ) {
            const peer = this.extensions.controlPeer(e.side);
            if (peer && this.control.mode === "local")
              void this.control
                .start(peer.fingerprint, e.side, e.y)
                .catch((error) => {
                  this.state.error = error.message;
                  this.emit("change");
                });
          } else if (e.type === "return" || e.type === "emergency")
            void this.control.stop();
          else if (validInput(e)) this.control.push(e);
        } catch {
          /* Malformed helper output never reaches the network. */
        }
      });
    });
    child.once("exit", () => {
      if (this.process === child) {
        this.process = undefined;
        clearInterval(this.heartbeat);
        void this.control.stop();
        this.state.error = "输入模块已停止，请重新开启键鼠共享。";
        void this.extensions.setSettings(
          this.extensions.snapshot().clipboardEnabled,
          false,
        );
        this.emit("change");
      }
    });
    try {
      await ready;
      this.configuration = "";
      this.configure();
      this.heartbeat = setInterval(() => this.send({ cmd: "heartbeat" }), 400);
    } catch (e) {
      this.stop();
      throw e;
    }
  }
  configure() {
    if (!this.process) return;
    const value = {
      cmd: "enable",
      left: !!this.extensions.controlPeer("left"),
      right: !!this.extensions.controlPeer("right"),
    };
    const signature = JSON.stringify(value);
    if (signature === this.configuration) return;
    this.configuration = signature;
    this.send(value);
  }
  stop() {
    clearInterval(this.heartbeat);
    this.send({ cmd: "disable" });
    const child = this.process;
    this.process = undefined;
    child?.stdin.end();
    if (child) {
      const timer = setTimeout(() => child.kill(), 500);
      timer.unref();
    }
    void this.control.stop();
  }
}
