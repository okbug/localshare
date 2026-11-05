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
import { NativeInputLifecycle } from "./native-input-lifecycle";
import { parseDisplayLayout } from "../shared/displays";
import type { DisplayLayout } from "../shared/types";
export class NativeInput extends EventEmitter {
  state = {
    available: false,
    permission: false,
    recovering: false,
    recoveryFailed: false,
    error: undefined as string | undefined,
    accessibility: undefined as boolean | undefined,
    inputMonitoring: undefined as boolean | undefined,
    layout: undefined as DisplayLayout | undefined,
  };
  private process?: ChildProcessWithoutNullStreams;
  private heartbeat?: ReturnType<typeof setInterval>;
  private configuration = "";
  private layoutRequest?: Promise<DisplayLayout>;
  private layoutReadAt = 0;
  private commands = new NativeCommands((command) => this.send(command, true));
  private lifecycle: NativeInputLifecycle<ChildProcessWithoutNullStreams>;
  private starting?: Promise<void>;
  private startGeneration = 0;
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
    this.lifecycle = new NativeInputLifecycle({
      request: (child, command, ack, id, payload) => {
        if (this.process !== child)
          return Promise.reject(new Error("原生输入模块已更换"));
        return this.commands.request({ ...payload, cmd: command }, ack, id);
      },
      cancelActivation: () =>
        this.commands.failActivation(new Error("输入切换已取消")),
      isLive: (child) =>
        child.exitCode === null &&
        child.signalCode === null &&
        !child.killed &&
        child.stdin.writable,
      terminate: (child) => this.terminateChild(child),
      recoverAfterExit: () => this.recoverAfterExit(),
      disable: () => {
        const disabled = this.extensions.setSettings(
          this.extensions.snapshot().clipboardEnabled,
          false,
        );
        void disabled.catch(() => {});
        this.configure();
        return disabled;
      },
      fallback: () => {
        this.state.error =
          "输入模块未确认释放，已关闭键鼠共享并尝试恢复本机鼠标；请确认后重新开启。";
        this.extensions.emit("notice", this.state.error);
      },
      changed: () => {
        this.state.recovering = this.lifecycle.recovering;
        this.state.recoveryFailed = this.lifecycle.recoveryFailed;
        if (this.state.recoveryFailed)
          this.state.error =
            "指针恢复失败，请点击恢复本机鼠标重试；必要时退出并重新打开应用。";
        this.emit("change");
      },
    });
    control.input = {
      capture: () => this.activate("capture", "captured"),
      receive: (position) => this.activate("receive", "receiving", position),
      inject: (event) => this.send({ cmd: "event", ...event }, true),
      release: () => this.releaseInput(),
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
  async readLayout(): Promise<DisplayLayout> {
    if (process.platform !== "win32")
      throw new Error("此设备尚不支持多屏入口设置");
    if (this.layoutRequest) return this.layoutRequest;
    if (this.state.layout && Date.now() - this.layoutReadAt < 500)
      return structuredClone(this.state.layout);
    this.layoutRequest = this.readLayoutProcess();
    try {
      return await this.layoutRequest;
    } finally {
      this.layoutRequest = undefined;
    }
  }
  private async readLayoutProcess(): Promise<DisplayLayout> {
    const data = await new Promise<string>((resolve, reject) =>
      execFile(
        this.helper,
        ["--layout"],
        { timeout: 3000, windowsHide: true, maxBuffer: 32768 },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      ),
    );
    const layout = parseDisplayLayout(JSON.parse(data));
    this.state.layout = layout;
    this.layoutReadAt = Date.now();
    this.emit("change");
    return layout;
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
              status.permission === true && status.protocolVersion === 5;
            if (status.displays) this.state.layout = parseDisplayLayout(status);
            this.state.accessibility = status.accessibility;
            this.state.inputMonitoring = status.listen;
            this.state.error =
              status.protocolVersion !== 5
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
  start(): Promise<void> {
    if (this.starting) return this.starting;
    const task = this.startProcess();
    this.starting = task;
    void task
      .finally(() => {
        if (this.starting === task) this.starting = undefined;
      })
      .catch(() => {});
    return task;
  }
  private async startProcess() {
    const generation = this.startGeneration;
    await this.lifecycle.waitForRelease();
    if (generation !== this.startGeneration)
      throw new Error("输入模块启动已取消");
    if (this.process) {
      this.configure();
      return;
    }
    await this.check();
    if (generation !== this.startGeneration)
      throw new Error("输入模块启动已取消");
    if (!this.state.permission)
      throw new Error(
        this.state.error ??
          "请先在系统设置中为 LocalShare 输入模块授予辅助功能权限",
      );
    const child = spawn(this.helper, [], { stdio: "pipe", windowsHide: true });
    this.process = child;
    this.lifecycle.attach(child);
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
        if (this.process !== child) return;
        if (line.length > 32768) return;
        try {
          const e = JSON.parse(line);
          if (e.type === "ready") {
            clearTimeout(timer);
            if (e.permission === true && e.protocolVersion === 5) {
              if (e.displays) this.state.layout = parseDisplayLayout(e);
              resolve();
            } else
              reject(
                new Error(
                  "输入模块缺少完整输入权限或版本不匹配，请检查辅助功能与输入监控权限后重启应用。",
                ),
              );
          } else if (e.type === "layout") {
            try {
              this.state.layout = parseDisplayLayout(e);
              this.layoutReadAt = Date.now();
              this.state.error = "Windows 屏幕排列已更新，请重新跨屏。";
            } catch {
              this.state.layout = undefined;
              this.state.error = "Windows 屏幕排列无法读取，已恢复本机控制。";
            }
            this.commands.fail(new Error(this.state.error));
            void this.control.stop().catch(() => {});
            this.emit("change");
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
            void this.control.stop().catch(() => {});
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
          } else if (e.type === "return")
            void this.control.stop().catch(() => {});
          else if (e.type === "emergency") {
            if (this.control.mode === "local")
              void this.recoverPointer().catch(() => {});
            else void this.control.stopSharing().catch(() => {});
          } else if (validInput(e)) this.control.push(e);
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
        void this.lifecycle
          .exited(child)
          .catch((error) => this.reportRecoveryError(error));
        void this.control.stop().catch(() => {});
        this.state.error = "输入模块已停止，请重新开启键鼠共享。";
        void this.extensions
          .setSettings(this.extensions.snapshot().clipboardEnabled, false)
          .catch(() => {});
        this.emit("change");
      }
    });
    try {
      await ready;
      if (this.process !== child || generation !== this.startGeneration)
        throw new Error("输入模块启动已取消");
      this.configuration = "";
      this.configure();
      this.heartbeat = setInterval(() => {
        if (this.process === child) this.send(this.lifecycle.heartbeat());
      }, 400);
    } catch (e) {
      if (this.process === child)
        await this.terminateChild(child).catch(() => {});
      throw e;
    }
  }
  configure() {
    if (!this.process) return;
    const allowed = this.extensions.snapshot().controlEnabled;
    const value = {
      cmd: "enable",
      left: allowed && !!this.extensions.controlPeer("left"),
      right: allowed && !!this.extensions.controlPeer("right"),
    };
    const signature = JSON.stringify(value);
    if (signature === this.configuration) return;
    this.configuration = signature;
    this.send(value);
  }
  private async activate(
    command: string,
    ack: "captured" | "receiving",
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.lifecycle.activate(this.process, command, ack, payload);
  }
  releaseInput(): Promise<void> {
    const task = this.lifecycle.release();
    void task.catch((error) => this.reportRecoveryError(error));
    return task;
  }
  recoverPointer(): Promise<void> {
    const task = this.lifecycle.recover();
    void task.then(
      () => {
        this.configuration = "";
        this.state.error = "已恢复本机鼠标，键鼠共享已关闭，请按需重新开启";
        this.emit("change");
      },
      (error) => this.reportRecoveryError(error),
    );
    return task;
  }
  private reportRecoveryError(error: unknown): void {
    this.state.error =
      error instanceof Error ? error.message : "本机指针恢复失败";
    this.emit("change");
  }
  private recoverAfterExit(): Promise<void> {
    if (process.platform !== "darwin") return Promise.resolve();
    return new Promise((resolve, reject) => {
      execFile(
        this.helper,
        ["--recover-pointer"],
        { timeout: 1500, windowsHide: true, maxBuffer: 32768 },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          try {
            const result = JSON.parse(stdout.trim());
            if (
              result.type !== "recovered" ||
              result.protocolVersion !== 5 ||
              result.ok !== true
            )
              throw new Error("本机指针恢复未获系统确认");
            resolve();
          } catch (failure) {
            reject(failure);
          }
        },
      );
    });
  }
  private async terminateChild(
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (this.process === child) {
      this.process = undefined;
      clearInterval(this.heartbeat);
      this.configuration = "";
      this.commands.fail(new Error("原生输入模块正在退出"));
    }
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (exited()) return;
    const wait = (timeout: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          child.off("exit", done);
          resolve();
        };
        const timer = setTimeout(done, timeout);
        child.once("exit", done);
        if (exited()) done();
      });
    const graceful = wait(350);
    try {
      child.stdin.end();
    } catch {
      /* Continue to bounded termination. */
    }
    await graceful;
    if (!exited()) {
      const ended = wait(350);
      child.kill();
      await ended;
    }
    if (!exited()) {
      const ended = wait(350);
      child.kill("SIGKILL");
      await ended;
    }
    if (!exited()) throw new Error("输入模块仍未退出，无法确认指针已释放");
  }
  stop(): Promise<void> {
    ++this.startGeneration;
    const task = (async () => {
      await this.releaseInput();
      const child = this.process;
      if (child) await this.terminateChild(child);
    })();
    void task.catch((error) => this.reportRecoveryError(error));
    void this.control.stop().catch(() => {});
    return task;
  }
}
