import { EventEmitter } from "node:events";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import type {
  Device,
  PairRequest,
  TrustedPeer,
  ExtensionState,
  DisplayLayout,
} from "../shared/types";
import {
  entryDisplays,
  parseDisplayLayout,
  validDisplayId,
} from "../shared/displays";
import {
  LocalShareService,
  deviceInfo,
  readJSON,
  reply,
  ipOf,
} from "./service";
import { fingerprint } from "./identity";
import { atomicJSON } from "./files";
import {
  request,
  jsonReply,
  HttpError,
  closeConnections,
  type Reply,
} from "./transport";
interface Trust extends TrustedPeer {
  inbound: string;
  outbound: string;
}
interface Pending {
  public: PairRequest;
  token: string;
  accepted: boolean;
  resolve?: (yes: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  abort?: AbortController;
}
const PREFIX = "/api/localshare/v1";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function pairCode(a: string, b: string, nonce: string) {
  return (
    parseInt(digest([...[a, b].sort(), nonce].join(":")).slice(0, 10), 16) %
    1000000
  )
    .toString()
    .padStart(6, "0");
}
export class Extensions extends EventEmitter {
  private trusted = new Map<string, Trust>();
  private pending = new Map<string, Pending>();
  private lastPair = new Map<string, number>();
  private lastClipboardHash = "";
  private clipboardEnabled = false;
  private controlEnabled = false;
  private persistence: Promise<void> = Promise.resolve();
  private displayLayouts = new Map<string, DisplayLayout>();
  displayProvider?: () => Promise<DisplayLayout>;
  controlHandler?: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    peer: Trust,
  ) => Promise<boolean>;
  constructor(readonly service: LocalShareService) {
    super();
  }
  async start() {
    try {
      const saved = JSON.parse(
        await readFile(
          join(this.service.options.dataDir, "trust.json"),
          "utf8",
        ),
      );
      for (const p of saved.peers ?? [])
        if (
          /^[A-F0-9]{64}$/.test(p.fingerprint) &&
          /^[a-f0-9]{64}$/.test(p.inbound) &&
          /^[a-f0-9]{64}$/.test(p.outbound)
        )
          this.trusted.set(p.fingerprint, {
            ...p,
            invertScroll: p.invertScroll === true,
            swapAltWin: p.swapAltWin === true,
            entryDisplay: validDisplayId(p.entryDisplay) ? p.entryDisplay : "",
          });
      // Sharing requires a fresh opt-in after every application restart.
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        this.emit("notice", "配对信息无法读取，请重新配对");
    }
    this.service.extensionHandler = (req, res, url) =>
      this.route(req, res, url);
    this.publish();
  }
  snapshot(): ExtensionState {
    return {
      trusted: [...this.trusted.values()].map(
        ({ inbound: _i, outbound: _o, ...p }) => ({ ...p }),
      ),
      pairing: [...this.pending.values()].map((p) => structuredClone(p.public)),
      clipboardEnabled: this.clipboardEnabled,
      controlEnabled: this.controlEnabled,
      control: this.service.extensionSnapshot.control,
      displayLayouts: Object.fromEntries(
        [...this.displayLayouts].map(([fp, layout]) => [
          fp,
          structuredClone(layout),
        ]),
      ),
    };
  }
  publish() {
    this.service.extensionSnapshot = this.snapshot();
    this.service.changed();
  }
  private save() {
    const value = { peers: [...this.trusted.values()] };
    this.persistence = this.persistence.then(() =>
      atomicJSON(join(this.service.options.dataDir, "trust.json"), value),
    );
    return this.persistence;
  }
  private addPending(publicData: PairRequest, token: string): Pending {
    if (
      this.pending.size >= 4 ||
      [...this.pending.values()].some(
        (p) => p.public.peer.fingerprint === publicData.peer.fingerprint,
      )
    )
      throw new HttpError(429, "已有配对请求");
    const p: Pending = {
      public: publicData,
      token,
      accepted: false,
      timer: setTimeout(() => this.respondPair(publicData.id, false), 90000),
    };
    p.timer.unref();
    this.pending.set(publicData.id, p);
    return p;
  }
  private removePending(id: string) {
    const p = this.pending.get(id);
    if (p) clearTimeout(p.timer);
    this.pending.delete(id);
    this.publish();
  }
  respondPair(id: string, accept: boolean) {
    const p = this.pending.get(id);
    if (!p) return;
    p.accepted = accept;
    p.resolve?.(accept);
    p.resolve = undefined;
    if (!accept) {
      p.abort?.abort();
      this.removePending(id);
    }
    this.publish();
  }
  async pair(fp: string) {
    const device = this.service.devices.get(fp);
    if (!device?.localshare || device.protocol !== "https")
      throw new Error("共享扩展需要 HTTPS LocalShare 设备");
    if (this.trusted.has(fp)) throw new Error("设备已经配对");
    const id = randomUUID();
    const nonce = randomBytes(16).toString("hex");
    const p = this.addPending(
      {
        id,
        peer: device,
        code: pairCode(this.service.info.fingerprint, fp, nonce),
        outgoing: true,
      },
      "",
    );
    p.abort = new AbortController();
    const approved = new Promise<boolean>((resolve) => {
      p.resolve = resolve;
    });
    this.publish();
    this.emit("pairing", structuredClone(p.public));
    try {
      const result = jsonReply<{ id: string; token: string; code: string }>(
        await request(this.service.identity, device, `${PREFIX}/pair/request`, {
          json: { info: this.service.info, nonce },
          signal: p.abort.signal,
        }),
      );
      if (result.code !== p.public.code || !/^[a-f0-9]{64}$/.test(result.token))
        throw new Error("配对校验码不匹配");
      if (!(await approved)) throw new Error("配对已取消");
      const inbound = randomBytes(32).toString("hex");
      jsonReply(
        await request(this.service.identity, device, `${PREFIX}/pair/commit`, {
          json: { id: result.id, token: result.token, returnToken: inbound },
          signal: p.abort.signal,
        }),
      );
      this.trusted.set(fp, {
        fingerprint: fp,
        alias: device.alias,
        inbound,
        outbound: result.token,
        clipboard: false,
        control: false,
        side: "right",
        invertScroll: false,
        swapAltWin: false,
        entryDisplay: "",
      });
      await this.save();
    } finally {
      p.resolve?.(false);
      this.removePending(id);
    }
  }
  async unpair(fp: string) {
    const trust = this.trusted.get(fp);
    const device = this.service.devices.get(fp);
    if (!trust) return;
    this.trusted.delete(fp);
    this.displayLayouts.delete(fp);
    await this.save();
    this.publish();
    this.emit("trustChanged", fp);
    closeConnections(this.service.identity.fingerprint, fp);
    if (device?.protocol === "https")
      await request(this.service.identity, device, `${PREFIX}/unpair`, {
        headers: { authorization: `Bearer ${trust.outbound}` },
        timeout: 5000,
      }).catch(() => {});
  }
  async setPeer(
    fp: string,
    patch: Partial<
      Pick<
        TrustedPeer,
        | "clipboard"
        | "control"
        | "side"
        | "invertScroll"
        | "swapAltWin"
        | "entryDisplay"
      >
    >,
  ) {
    const peer = this.trusted.get(fp);
    if (!peer) throw new Error("设备尚未配对");
    const next = { ...peer };
    if (patch.entryDisplay !== undefined) {
      if (patch.entryDisplay !== "" && !validDisplayId(patch.entryDisplay))
        throw new Error("入口显示器设置无效");
      next.entryDisplay = patch.entryDisplay;
    }
    for (const key of [
      "clipboard",
      "control",
      "invertScroll",
      "swapAltWin",
    ] as const)
      if (patch[key] !== undefined) {
        if (typeof patch[key] !== "boolean") throw new Error("开关值无效");
        next[key] = patch[key]!;
      }
    if (patch.side !== undefined) {
      if (patch.side !== "left" && patch.side !== "right")
        throw new Error("位置无效");
      next.side = patch.side;
      const layout = this.displayLayouts.get(fp);
      if (
        next.entryDisplay &&
        layout &&
        !entryDisplays(layout, next.side === "right" ? "left" : "right").some(
          (d) => d.id === next.entryDisplay,
        )
      )
        next.entryDisplay = "";
    }
    this.trusted.set(fp, next);
    await this.save();
    this.publish();
    this.emit("trustChanged", fp);
  }
  async setSettings(clipboard: boolean, control: boolean) {
    this.clipboardEnabled = clipboard;
    this.controlEnabled = control;
    this.publish();
    this.emit("settingsChanged");
  }
  async fetchDisplayLayout(fp: string): Promise<DisplayLayout> {
    const result = await this.call(fp, "/displays", {}, { timeout: 3000 });
    if (result.status === 404 || result.status === 501)
      throw new Error("对方不支持多屏入口设置，请升级对方的 LocalShare");
    const layout = parseDisplayLayout(jsonReply(result));
    // Unpairing during a request must not republish cached metadata.
    const peer = this.trusted.get(fp);
    if (!peer) throw new Error("设备已取消配对");
    this.displayLayouts.set(fp, layout);
    if (
      peer.entryDisplay &&
      !entryDisplays(layout, peer.side === "right" ? "left" : "right").some(
        (d) => d.id === peer.entryDisplay,
      )
    ) {
      await this.setPeer(fp, { entryDisplay: "" });
      this.emit("notice", "原入口已不可用，已恢复自动选择；请重新跨屏。");
    }
    this.publish();
    return structuredClone(layout);
  }
  canControl(fp: string) {
    return this.controlEnabled && this.trusted.get(fp)?.control === true;
  }
  controlPeer(side: "left" | "right") {
    return [...this.trusted.values()].find(
      (p) =>
        p.control &&
        p.side === side &&
        this.service.devices.get(p.fingerprint)?.protocol === "https",
    );
  }
  private authorize(req: IncomingMessage): Trust {
    const cert = (req.socket as TLSSocket).getPeerCertificate?.();
    if (!cert?.raw) throw new HttpError(403, "扩展需要客户端证书");
    const peer = this.trusted.get(fingerprint(cert.raw));
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (
      !peer ||
      !token ||
      token.length !== peer.inbound.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(peer.inbound))
    )
      throw new HttpError(403, "设备未配对或凭据无效");
    return peer;
  }
  async call(
    fp: string,
    path: string,
    json?: unknown,
    options: { signal?: AbortSignal; timeout?: number } = {},
  ): Promise<Reply> {
    const trust = this.trusted.get(fp);
    const device = this.service.devices.get(fp);
    if (!trust || !device) throw new Error("可信设备当前不可用");
    if (device.protocol !== "https")
      throw new Error("设备协同仅允许 HTTPS，已拒绝不安全的连接降级");
    return request(
      this.service.identity,
      { ...device, fingerprint: fp },
      `${PREFIX}${path}`,
      {
        json,
        headers: { authorization: `Bearer ${trust.outbound}` },
        keepAlive: path.startsWith("/control/"),
        ...options,
      },
    );
  }
  noteClipboardChange(text: string) {
    this.lastClipboardHash = digest(text);
  }
  async sendClipboard(text: string) {
    if (
      !this.clipboardEnabled ||
      !text ||
      Buffer.byteLength(text) > 1024 * 1024
    )
      return;
    this.noteClipboardChange(text);
    await Promise.allSettled(
      [...this.trusted.values()]
        .filter((p) => p.clipboard && this.service.devices.has(p.fingerprint))
        .map(async (p) => {
          const response = await this.call(
            p.fingerprint,
            "/clipboard",
            { text },
            { timeout: 5000 },
          );
          if (response.status !== 200 && response.status !== 409)
            this.emit("notice", `剪贴板未同步至 ${p.alias}`);
        }),
    );
  }
  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (req.method !== "POST") {
      reply(res, 405);
      return true;
    }
    const path = url.pathname.slice(PREFIX.length);
    if (path === "/pair/request") {
      const cert = (req.socket as TLSSocket).getPeerCertificate?.();
      if (!cert?.raw) throw new HttpError(403, "配对需要客户端证书");
      const fp = fingerprint(cert.raw);
      if (this.trusted.has(fp)) throw new HttpError(409, "设备已配对");
      if (Date.now() - (this.lastPair.get(fp) ?? 0) < 5000)
        throw new HttpError(429, "配对请求太频繁");
      if (this.lastPair.size > 512) this.lastPair.clear();
      this.lastPair.set(fp, Date.now());
      const data = await readJSON(req, 16384);
      const info = deviceInfo(data.info);
      if (
        info.fingerprint !== fp ||
        !info.localshare ||
        typeof data.nonce !== "string" ||
        !/^[a-f0-9]{32}$/.test(data.nonce)
      )
        throw new HttpError(400, "配对信息无效");
      const peer: Device = { ...info, ip: ipOf(req), lastSeen: Date.now() };
      this.service.devices.set(fp, peer);
      const id = randomUUID();
      const p = this.addPending(
        {
          id,
          peer,
          code: pairCode(this.service.info.fingerprint, fp, data.nonce),
          outgoing: false,
        },
        randomBytes(32).toString("hex"),
      );
      res.once("close", () => {
        if (!res.writableEnded) this.respondPair(id, false);
      });
      const accept = await new Promise<boolean>((resolve) => {
        p.resolve = resolve;
        this.publish();
        this.emit("pairing", structuredClone(p.public));
      });
      if (!accept) reply(res, 403, { error: "对方拒绝配对" });
      else reply(res, 200, { id, token: p.token, code: p.public.code });
      return true;
    }
    if (path === "/pair/commit") {
      const data = await readJSON(req, 16384);
      const p = this.pending.get(data.id);
      const cert = (req.socket as TLSSocket).getPeerCertificate?.();
      if (
        !cert?.raw ||
        !p ||
        p.public.outgoing ||
        !p.accepted ||
        fingerprint(cert.raw) !== p.public.peer.fingerprint ||
        data.token !== p.token ||
        typeof data.returnToken !== "string" ||
        !/^[a-f0-9]{64}$/.test(data.returnToken)
      )
        throw new HttpError(403, "配对未获得双端确认");
      this.trusted.set(p.public.peer.fingerprint, {
        fingerprint: p.public.peer.fingerprint,
        alias: p.public.peer.alias,
        inbound: p.token,
        outbound: data.returnToken,
        clipboard: false,
        control: false,
        side: "left",
        invertScroll: false,
        swapAltWin: false,
        entryDisplay: "",
      });
      await this.save();
      this.removePending(p.public.id);
      reply(res, 200, { ok: true });
      return true;
    }
    const peer = this.authorize(req);
    const known = this.service.devices.get(peer.fingerprint);
    if (known) known.lastSeen = Date.now();
    if (path === "/unpair") {
      this.trusted.delete(peer.fingerprint);
      this.displayLayouts.delete(peer.fingerprint);
      await this.save();
      this.publish();
      this.emit("trustChanged", peer.fingerprint);
      reply(res, 200, { ok: true });
      return true;
    }
    if (path === "/clipboard") {
      if (!this.clipboardEnabled || !peer.clipboard)
        throw new HttpError(409, "剪贴板同步未开启");
      const data = await readJSON(req, 1024 * 1024 + 16384);
      if (
        typeof data.text !== "string" ||
        !data.text ||
        Buffer.byteLength(data.text) > 1024 * 1024
      )
        throw new HttpError(400, "文本无效或过大");
      const hash = digest(data.text);
      if (this.lastClipboardHash !== hash) {
        this.lastClipboardHash = hash;
        this.emit("clipboard", data.text);
      }
      reply(res, 200, { ok: true });
      return true;
    }
    if (path === "/displays") {
      await readJSON(req, 1024);
      if (!this.displayProvider)
        throw new HttpError(501, "此设备不支持多屏入口设置，请升级应用");
      reply(res, 200, parseDisplayLayout(await this.displayProvider()));
      return true;
    }
    if (path.startsWith("/control/") && this.controlHandler)
      return this.controlHandler(req, res, url, peer);
    reply(res, 404);
    return true;
  }
  async stop() {
    closeConnections(this.service.identity.fingerprint);
    for (const [id, p] of this.pending) {
      p.resolve?.(false);
      p.abort?.abort();
      clearTimeout(p.timer);
      this.pending.delete(id);
    }
    await this.persistence.catch(() => {});
  }
}
