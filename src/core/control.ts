import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Extensions } from "./extensions";
import { readJSON, reply } from "./service";
import { HttpError, jsonReply } from "./transport";
import type { TrustedPeer } from "../shared/types";
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
  receive(position: { side: "left" | "right"; y: number }): Promise<void>;
  inject(event: InputEvent): void;
  release(): void;
}
interface Session {
  id: string;
  fp: string;
  mode: "sending" | "receiving";
  side: "left" | "right";
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
          this.session?.fp === peer.fingerprint &&
          this.session.id === body.id
        )
          await this.stop(false);
        reply(res, 200, { ok: true });
        return true;
      }
      if (!extensions.canControl(peer.fingerprint)) {
        const receiver = extensions.service.info.alias;
        const message = extensions.snapshot().controlEnabled
          ? `「${receiver}」尚未允许「${peer.alias}」共享键鼠。请在「${receiver}」的「设备协同 → 已配对设备」中，打开「${peer.alias}」设备卡片里的「共享键鼠」开关。`
          : `「${receiver}」的键鼠总开关未开启。请在「${receiver}」的「设备协同」中打开「跨屏键盘与鼠标」，并在「${peer.alias}」设备卡片里打开「共享键鼠」。`;
        throw new HttpError(403, message);
      }
      if (path === "start") {
        if (this.session) throw new HttpError(409, "已有活动控制会话");
        if (
          typeof body.id !== "string" ||
          body.id.length > 100 ||
          !["left", "right"].includes(body.side) ||
          typeof body.y !== "number" ||
          body.y < 0 ||
          body.y > 1
        )
          throw new HttpError(400, "控制参数无效");
        this.session = {
          id: body.id,
          fp: peer.fingerprint,
          mode: "receiving",
          side: body.side,
          lastSeen: Date.now(),
          seq: 0,
          sentSeq: 0,
          ack: 0,
          queue: [],
          abort: new AbortController(),
          polling: false,
        };
        const receiving = this.session;
        try {
          await this.input?.receive({ side: body.side, y: body.y });
          if (this.session !== receiving) throw new Error("输入接收已取消");
        } catch (error) {
          await this.stop(false);
          throw new HttpError(503, (error as Error).message);
        }
        this.publish();
        this.emit("receive", { side: body.side, y: body.y });
        reply(res, 200, { ok: true });
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
      peer: this.session
        ? this.extensions.service.devices.get(this.session.fp)?.alias
        : undefined,
    };
    this.extensions.publish();
  }
  async start(fp: string, side: "left" | "right", y: number) {
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
    try {
      await this.input?.capture();
      if (this.session !== s) throw new Error("本机截获已取消");
      jsonReply(
        await this.extensions.call(
          fp,
          "/control/start",
          { id: s.id, side, y },
          { timeout: 1500, signal: s.abort.signal },
        ),
      );
      if (this.session !== s) throw new Error("控制连接已取消");
      this.publish();
      this.emit("capture", { side });
    } catch (e) {
      await this.stop();
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
  async stop(notify = true) {
    const s = this.session;
    if (!s) return;
    this.session = undefined;
    s.abort.abort();
    s.wake?.();
    this.input?.release();
    this.publish();
    this.emit("release");
    if (notify)
      await this.extensions
        .call(s.fp, "/control/stop", { id: s.id }, { timeout: 1000 })
        .catch(() => {});
  }
  async dispose() {
    clearInterval(this.timer);
    await this.stop();
  }
}
