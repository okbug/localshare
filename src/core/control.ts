import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Extensions } from "./extensions";
import { readJSON, reply } from "./service";
import { HttpError, jsonReply } from "./transport";
import type { TrustedPeer } from "../shared/types";
import {
  validDisplayId,
  entryDisplays,
  parseDisplayLayout,
} from "../shared/displays";
const swappedModifiers: Readonly<Record<number, number>> = {
  164: 91,
  165: 92,
  91: 164,
  92: 165,
};
export type InputEvent =
  | { type: "move"; dx: number; dy: number }
  | { type: "key"; key: number; down: boolean }
  | { type: "button"; button: number; down: boolean }
  | { type: "scroll"; dx: number; dy: number };
export interface InputAdapter {
  capture(): Promise<void>;
  receive(position: {
    side: "left" | "right";
    y: number;
    display?: string;
    manual?: boolean;
  }): Promise<void>;
  inject(event: InputEvent): void;
  release(): void | Promise<void>;
}
interface Session {
  id: string;
  fp: string;
  mode: "sending" | "receiving";
  side: "left" | "right";
  interaction: "edge" | "manual";
  lastSeen: number;
  seq: number;
  sentSeq: number;
  ack: number;
  queue: { seq: number; event: InputEvent }[];
  abort: AbortController;
  wake?: () => void;
  polling: boolean;
  inputPreferences?: Pick<TrustedPeer, "invertScroll" | "swapAltWin">;
}
export function validInput(e: unknown): e is InputEvent {
  if (!e || typeof e !== "object") return false;
  const v = e as Record<string, unknown>;
  if (v.type === "move" || v.type === "scroll")
    return (
      typeof v.dx === "number" &&
      Number.isFinite(v.dx) &&
      Math.abs(v.dx) <= 2000 &&
      typeof v.dy === "number" &&
      Number.isFinite(v.dy) &&
      Math.abs(v.dy) <= 2000
    );
  if (v.type === "key")
    return (
      Number.isInteger(v.key) &&
      (v.key as number) >= 0 &&
      (v.key as number) <= 255 &&
      typeof v.down === "boolean"
    );
  if (v.type === "button")
    return (
      Number.isInteger(v.button) &&
      (v.button as number) >= 0 &&
      (v.button as number) <= 2 &&
      typeof v.down === "boolean"
    );
  return false;
}
export class Control extends EventEmitter {
  input?: InputAdapter;
  flushClipboard?: () => Promise<void>;
  // Poll failure or a normal stop may win the race with stopClipboard. Only
  // the latest session for this peer may finish that pause, never an older one.
  private latestSessionByPeer = new Map<string, string>();
  private nativeReleases = new Map<
    string,
    { fp: string; id: string; task: Promise<boolean>; settled: boolean }
  >();
  private session?: Session;
  private timer: ReturnType<typeof setInterval>;
  get mode() {
    return this.session?.mode ?? "local";
  }
  constructor(readonly extensions: Extensions) {
    super();
    extensions.controlHandler = async (req, res, url, peer) => {
      const path = url.pathname.split("/control/")[1];
      const body = await readJSON(req, 32768);
      if (path === "stop") {
        if (
          body.stopClipboard !== undefined &&
          typeof body.stopClipboard !== "boolean"
        )
          throw new HttpError(400, "停止参数无效");
        const active =
          this.session?.fp === peer.fingerprint && this.session.id === body.id
            ? this.session
            : undefined;
        const current =
          typeof body.id === "string" &&
          this.latestSessionByPeer.get(peer.fingerprint) === body.id;
        const released = active
          ? this.releaseSession(active)
          : this.releaseTask(peer.fingerprint, body.id);
        if (body.stopClipboard === true && current) {
          const paused = extensions.pauseClipboard(peer.fingerprint);
          const [results, inputReleased] = await Promise.all([
            Promise.allSettled([paused, this.drainClipboard()]),
            released,
          ]);
          const clipboardStopped = results.every(
            (r) => r.status === "fulfilled",
          );
          if (!clipboardStopped)
            extensions.emit(
              "notice",
              "键鼠已释放，但文本同步暂停未完整保存，请检查设备开关。",
            );
          reply(res, 200, { ok: true, clipboardStopped, inputReleased });
        } else
          reply(res, 200, {
            ok: true,
            inputReleased: await released,
            ...(body.stopClipboard === true ? { clipboardStopped: false } : {}),
          });
        return true;
      }
      if (!extensions.canControl(peer.fingerprint)) {
        const receiver = extensions.service.info.alias;
        const message = extensions.snapshot().controlEnabled
          ? `「${receiver}」尚未允许「${peer.alias}」共享键鼠。请在「${receiver}」的「设备协同 → 已配对设备」中，打开「${peer.alias}」设备卡片里的「共享键鼠」开关。`
          : `「${receiver}」的键鼠总开关未开启。请在「${receiver}」的「设备协同」中打开「跨屏键盘与鼠标」，并在「${peer.alias}」设备卡片里打开「共享键鼠」。`;
        throw new HttpError(403, message);
      }
      if (path === "capabilities") {
        reply(res, 200, {
          version: 1,
          manual: true,
          stopSharing: true,
          releaseAck: true,
        });
        return true;
      }
      if (path === "start") {
        if (this.session) throw new HttpError(409, "已有活动控制会话");
        if (
          typeof body.id !== "string" ||
          body.id.length > 100 ||
          (body.interaction === "manual" &&
            !/^[A-Za-z0-9-]{1,100}$/.test(body.id)) ||
          !["left", "right"].includes(body.side) ||
          typeof body.y !== "number" ||
          body.y < 0 ||
          body.y > 1 ||
          (body.display !== undefined && !validDisplayId(body.display)) ||
          (body.interaction !== undefined &&
            !["edge", "manual"].includes(body.interaction)) ||
          (body.interaction === "manual" && body.display !== undefined)
        )
          throw new HttpError(400, "控制参数无效");
        this.session = {
          id: body.id,
          fp: peer.fingerprint,
          mode: "receiving",
          side: body.side,
          interaction: body.interaction ?? "edge",
          lastSeen: Date.now(),
          seq: 0,
          sentSeq: 0,
          ack: 0,
          queue: [],
          abort: new AbortController(),
          polling: false,
        };
        const receiving = this.session;
        this.rememberSession(receiving.fp, receiving.id);
        try {
          if (body.display) {
            if (!extensions.displayProvider)
              throw new Error("此设备不支持指定入口，请升级应用");
            const layout = parseDisplayLayout(
              await extensions.displayProvider(),
            );
            if (
              !entryDisplays(
                layout,
                body.side === "right" ? "left" : "right",
              ).some((d) => d.id === body.display)
            )
              throw new Error(
                "入口显示器不存在或此侧被其他屏幕遮挡，请刷新屏幕排列",
              );
            if (this.session !== receiving) throw new Error("输入接收已取消");
          }
          await this.input?.receive({
            side: body.side,
            y: body.y,
            ...(body.display ? { display: body.display } : {}),
            ...(body.interaction === "manual" ? { manual: true } : {}),
          });
          if (this.session !== receiving) throw new Error("输入接收已取消");
        } catch (error) {
          if (this.session === receiving) await this.stop(false);
          throw new HttpError(503, (error as Error).message);
        }
        this.publish();
        this.emit("receive", { side: body.side, y: body.y });
        reply(res, 200, { ok: true, interaction: receiving.interaction });
        void this.poll(this.session);
        return true;
      }
      const s = this.session;
      if (
        !s ||
        s.mode !== "sending" ||
        s.fp !== peer.fingerprint ||
        body.id !== s.id
      )
        throw new HttpError(409, "没有对应控制会话");
      if (path === "events") {
        if (s.polling) throw new HttpError(409, "重复轮询");
        if (!Number.isSafeInteger(body.ack) || body.ack < 0 || body.ack > s.seq)
          throw new HttpError(400, "事件序号无效");
        s.polling = true;
        s.lastSeen = Date.now();
        s.queue = s.queue.filter((e) => e.seq > body.ack);
        try {
          if (!s.queue.length)
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                s.wake = undefined;
                resolve();
              }, 400);
              s.wake = () => {
                clearTimeout(timer);
                s.wake = undefined;
                resolve();
              };
            });
          if (s.queue.length)
            await new Promise<void>((resolve) => setTimeout(resolve, 4));
          const batch = s.queue.slice(0, 256);
          if (batch.length) s.sentSeq = Math.max(s.sentSeq, batch.at(-1)!.seq);
          reply(res, 200, { id: s.id, events: batch });
        } finally {
          s.polling = false;
        }
        return true;
      }
      reply(res, 404);
      return true;
    };
    const check = () => {
      if (this.session && !extensions.canControl(this.session.fp))
        void this.stop();
    };
    extensions.on("trustChanged", check);
    extensions.on("settingsChanged", check);
    this.timer = setInterval(() => {
      if (this.session && Date.now() - this.session.lastSeen > 2000)
        void this.stop();
    }, 250);
    this.timer.unref();
  }
  private publish() {
    this.extensions.service.extensionSnapshot.control = {
      mode: this.mode,
      id: this.session?.id,
      interaction: this.session?.interaction,
      fingerprint: this.session?.fp,
      peer: this.session
        ? this.extensions.service.devices.get(this.session.fp)?.alias
        : undefined,
    };
    this.extensions.publish();
  }
  async start(
    fp: string,
    side: "left" | "right",
    y: number,
    interaction: "edge" | "manual" = "edge",
  ) {
    if (interaction !== "edge" && interaction !== "manual")
      throw new Error("控制模式无效");
    if (!this.extensions.canControl(fp))
      throw new Error("请先在两端开启键鼠共享");
    if (this.session) throw new Error("已有活动控制会话");
    const peer = this.extensions
      .snapshot()
      .trusted.find((p) => p.fingerprint === fp)!;
    const s: Session = {
      id: randomUUID(),
      fp,
      mode: "sending",
      side,
      interaction,
      lastSeen: Date.now(),
      seq: 0,
      sentSeq: 0,
      ack: 0,
      queue: [],
      abort: new AbortController(),
      polling: false,
      // A held modifier must use the same mapping for both down and up.
      inputPreferences: {
        invertScroll: peer.invertScroll,
        swapAltWin: peer.swapAltWin,
      },
    };
    this.session = s;
    this.rememberSession(s.fp, s.id);
    try {
      if (interaction === "manual") {
        const response = await this.extensions.call(
          fp,
          "/control/capabilities",
          {},
          { timeout: 1500, signal: s.abort.signal },
        );
        if ([404, 409, 501].includes(response.status))
          throw new Error(
            "对方不支持确认式输入恢复，请将两端升级到 0.1.7 或更新版本",
          );
        const capability = jsonReply<{
          version?: unknown;
          manual?: unknown;
          stopSharing?: unknown;
          releaseAck?: unknown;
        } | null>(response);
        if (
          capability?.version !== 1 ||
          capability?.manual !== true ||
          capability?.stopSharing !== true ||
          capability?.releaseAck !== true
        )
          throw new Error(
            "对方不支持确认式输入恢复，请将两端升级到 0.1.7 或更新版本",
          );
        if (this.session !== s) throw new Error("控制连接已取消");
      }
      if (interaction === "edge" && peer.entryDisplay) {
        const layout = await this.extensions.fetchDisplayLayout(fp);
        if (
          !entryDisplays(layout, side === "right" ? "left" : "right").some(
            (d) => d.id === peer.entryDisplay,
          )
        )
          throw new Error("入口显示器不可用，请刷新屏幕排列并重新选择入口");
        if (this.session !== s) throw new Error("控制连接已取消");
      }
      await this.input?.capture();
      if (this.session !== s) throw new Error("本机截获已取消");
      const response = jsonReply<{ interaction?: unknown }>(
        await this.extensions.call(
          fp,
          "/control/start",
          {
            id: s.id,
            side,
            y,
            ...(interaction === "edge" && peer.entryDisplay
              ? { display: peer.entryDisplay }
              : {}),
            ...(interaction === "manual" ? { interaction: "manual" } : {}),
          },
          { timeout: 1500, signal: s.abort.signal },
        ),
      );
      if (interaction === "manual" && response?.interaction !== "manual")
        throw new Error("对方未确认手动模式，请升级对方应用");
      if (this.session !== s) throw new Error("控制连接已取消");
      this.publish();
      this.emit("capture", { side });
    } catch (e) {
      if (this.session === s) await this.stop();
      throw e;
    }
  }
  push(event: InputEvent) {
    if (!validInput(event)) throw new Error("输入事件无效");
    const s = this.session;
    if (s?.mode !== "sending") return;
    if (event.type === "scroll" && s.inputPreferences?.invertScroll)
      event = {
        ...event,
        dx: event.dx === 0 ? 0 : -event.dx,
        dy: event.dy === 0 ? 0 : -event.dy,
      };
    else if (event.type === "key" && s.inputPreferences?.swapAltWin)
      event = { ...event, key: swappedModifiers[event.key] ?? event.key };
    const tail = s.queue.at(-1);
    if (
      event.type === "move" &&
      tail?.event.type === "move" &&
      tail.seq > s.sentSeq &&
      Math.abs(tail.event.dx + event.dx) <= 2000 &&
      Math.abs(tail.event.dy + event.dy) <= 2000
    ) {
      tail.event.dx += event.dx;
      tail.event.dy += event.dy;
      s.wake?.();
      return;
    }
    if (s.queue.length >= 1024) {
      void this.stop();
      return;
    }
    s.queue.push({ seq: ++s.seq, event });
    s.wake?.();
  }
  private async poll(s: Session) {
    while (this.session === s && !s.abort.signal.aborted) {
      try {
        const data = jsonReply<{
          id: string;
          events: { seq: number; event: InputEvent }[];
        }>(
          await this.extensions.call(
            s.fp,
            "/control/events",
            { id: s.id, ack: s.ack },
            { timeout: 1500, signal: s.abort.signal },
          ),
        );
        if (this.session !== s) break;
        if (
          data.id !== s.id ||
          !Array.isArray(data.events) ||
          data.events.length > 256
        )
          throw new Error("无效控制响应");
        s.lastSeen = Date.now();
        for (const item of data.events) {
          if (item.seq <= s.ack) continue;
          if (item.seq !== s.ack + 1 || !validInput(item.event))
            throw new Error("输入序号或事件无效");
          this.input?.inject(item.event);
          s.ack = item.seq;
          this.emit("input", item.event);
        }
      } catch {
        if (this.session === s) await this.stop();
        break;
      }
    }
  }
  private drainClipboard(): Promise<void> {
    try {
      return this.flushClipboard?.() ?? Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private rememberSession(fp: string, id: string) {
    this.latestSessionByPeer.set(fp, id);
    for (const [key, record] of this.nativeReleases)
      if (record.fp === fp && record.id !== id && record.settled)
        this.nativeReleases.delete(key);
  }
  private releaseTask(fp: string, id: unknown): Promise<boolean> {
    return typeof id === "string"
      ? (this.nativeReleases.get(JSON.stringify([fp, id]))?.task ??
          Promise.resolve(false))
      : Promise.resolve(false);
  }
  private releaseSession(s: Session): Promise<boolean> {
    if (this.session !== s) return this.releaseTask(s.fp, s.id);
    this.session = undefined;
    s.abort.abort();
    s.wake?.();
    const failed = () => {
      try {
        this.extensions.emit(
          "notice",
          "键鼠会话已停止，但本机输入恢复未确认，请使用恢复快捷键或退出应用。",
        );
      } catch {
        /* Diagnostics must not prevent publishing logical release. */
      }
      return false;
    };
    let task: Promise<boolean>;
    try {
      task = Promise.resolve(this.input?.release()).then(() => true, failed);
    } catch {
      task = Promise.resolve(failed());
    }
    const key = JSON.stringify([s.fp, s.id]),
      record = { fp: s.fp, id: s.id, task, settled: false };
    this.nativeReleases.set(key, record);
    void task.then(() => {
      record.settled = true;
      if (
        this.latestSessionByPeer.get(s.fp) !== s.id &&
        this.nativeReleases.get(key) === record
      )
        this.nativeReleases.delete(key);
    });
    this.publish();
    this.emit("release");
    return task;
  }
  async stopSharing(expectedSessionId?: string): Promise<void> {
    const s = this.session;
    if (!s || (expectedSessionId !== undefined && expectedSessionId !== s.id))
      return;
    const released = this.releaseSession(s);
    // setPeer revokes in memory synchronously, before its persistence await.
    const paused = this.extensions.pauseClipboard(s.fp);
    const notified = this.extensions
      .call(
        s.fp,
        "/control/stop",
        { id: s.id, stopClipboard: true },
        { timeout: 4000 },
      )
      .then((response) => {
        const status = jsonReply<{
          clipboardStopped?: unknown;
          inputReleased?: unknown;
        }>(response);
        if (status.clipboardStopped !== true || status.inputReleased !== true)
          throw new Error("对方未确认输入恢复或文本暂停");
      });
    const results = await Promise.allSettled([
      paused,
      notified,
      this.drainClipboard(),
      released,
    ]);
    if (results.some((r) => r.status === "rejected"))
      this.extensions.emit(
        "notice",
        "键鼠会话已停止；输入恢复或文本暂停尚未完整确认，请检查两端状态。",
      );
  }
  async stop(notify = true) {
    const s = this.session;
    if (!s) return;
    const released = this.releaseSession(s);
    const notified = notify
      ? this.extensions
          .call(s.fp, "/control/stop", { id: s.id }, { timeout: 4000 })
          .catch(() => {})
      : Promise.resolve();
    await Promise.all([released, notified]);
  }
  async dispose() {
    clearInterval(this.timer);
    await this.stop();
  }
}
