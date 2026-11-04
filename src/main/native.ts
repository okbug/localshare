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
import { NativeCommands } from "./native-commands";
export class NativeInput extends EventEmitter {
  state = {
    available: false,
    permission: false,
    error: undefined as string | undefined,
    accessibility: undefined as boolean | undefined,
    inputMonitoring: undefined as boolean | undefined,
  };
  private process?: ChildProcessWithoutNullStreams;
  private heartbeat?: ReturnType<typeof setInterval>;
  private configuration = "";
  private commands = new NativeCommands((command) => this.send(command, true));
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
    control.input = {
      capture: () => this.commands.request({ cmd: "capture" }, "captured"),
      receive: (position) =>
        this.commands.request({ cmd: "receive", ...position }, "receiving"),
      inject: (event) => this.send({ cmd: "event", ...event }, true),
      release: () => {
        this.commands.fail(new Error("输入切换已取消"));
        this.send({ cmd: "release" });
      },
    };
    control.on("capture", () => {
      this.state.error = undefined;
      this.emit("change");
    });
    control.on("receive", (position) => {
      this.state.error = undefined;
      this.emit("change");
    });
    extensions.on("trustChanged", () => this.configure());
  }
  private send(value: unknown, required = false) {
    if (this.process && !this.process.killed && this.process.stdin.writable)
      this.process.stdin.write(`${JSON.stringify(value)}\n`);
    else if (required)
      throw new Error("原生输入模块未运行，请重新开启键鼠共享");
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
            const status = JSON.parse(stdout.trim());
            this.state.permission =
              status.permission === true && status.protocolVersion === 2;
            this.state.accessibility = status.accessibility;
            this.state.inputMonitoring = status.listen;
            this.state.error =
              status.protocolVersion !== 2
                ? "输入模块版本不匹配，请安装完整的新版本 LocalShare。"
                : err
                  ? "输入模块检查失败"
                  : this.state.permission
                    ? undefined
                    : process.platform === "darwin"
                      ? status.accessibility && status.post
                        ? "Mac 无法完整监听键盘和鼠标，请在「隐私与安全性 → 输入监控」中允许 LocalShare / localshare-input，完全退出后重新打开。"
                        : "请在「隐私与安全性 → 辅助功能」中允许 LocalShare / localshare-input，返回后重新开启共享。"
                      : "系统未允许键盘与鼠标共享，请重新开启或检查输入模块。";
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
        this.state.accessibility
          ? "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
          : "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
  }
  async start() {
    if (this.process) {
      this.configure();
      return;
    }
    await this.check();
    if (!this.state.permission)
      throw new Error(
        this.state.error ??
          "请先在系统设置中为 LocalShare 输入模块授予辅助功能权限",
      );
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
            if (e.permission === true && e.protocolVersion === 2) resolve();
            else
              reject(
                new Error(
                  "输入模块缺少完整输入权限或版本不匹配，请检查辅助功能与输入监控权限后重启应用。",
                ),
              );
          } else if (this.commands.accept(e)) {
            // Activation is only committed after the native process confirms it.
          } else if (e.type === "error") {
            const operation =
              e.operation === "button"
                ? "鼠标点击"
                : e.operation === "key"
                  ? "键盘输入"
                  : "鼠标输入";
            const message =
              typeof e.message === "string"
                ? e.message.slice(0, 1000)
                : `Windows 拒绝了${operation}（系统错误 ${Number.isInteger(e.code) ? e.code : "未知"}）。请先在普通权限的记事本或桌面重试，确保目标应用的权限不高于 LocalShare。`;
            this.state.error = message;
            this.commands.fail(new Error(message));
            void this.control.stop();
            this.emit("change");
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
        this.commands.fail(new Error("原生输入模块已退出"));
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
    this.commands.fail(new Error("原生输入模块已停止"));
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
