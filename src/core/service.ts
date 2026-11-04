import { EventEmitter } from "node:events";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type {
  DeviceInfo,
  Device,
  FileMeta,
  Snapshot,
  Source,
  Transfer,
} from "../shared/types";
import { loadIdentity, fingerprint, type Identity } from "./identity";
import { request, jsonReply, HttpError, type Endpoint } from "./transport";
import { safeRelative, hashSource, receiveFile, atomicJSON } from "./files";
import { Discovery, addresses } from "./discovery";

const PREFIX = "/api/localsend/v2";
export const ipOf = (req: IncomingMessage) =>
  req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "";
export function deviceInfo(value: unknown): DeviceInfo {
  if (!value || typeof value !== "object")
    throw new HttpError(400, "设备信息无效");
  const v = value as Record<string, unknown>;
  if (
    typeof v.alias !== "string" ||
    !v.alias.trim() ||
    v.alias.length > 100 ||
    typeof v.fingerprint !== "string" ||
    v.fingerprint.length > 128 ||
    typeof v.version !== "string"
  )
    throw new HttpError(400, "设备信息无效");
  const port = v.port ?? 53317;
  if (
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65535
  )
    throw new HttpError(400, "端口无效");
  return {
    alias: v.alias,
    version: v.version,
    fingerprint: v.fingerprint.toUpperCase(),
    port: port as number,
    deviceModel:
      typeof v.deviceModel === "string"
        ? v.deviceModel.slice(0, 100)
        : "Unknown",
    deviceType:
      typeof v.deviceType === "string" ? v.deviceType.slice(0, 30) : "desktop",
    protocol: v.protocol === "http" ? "http" : "https",
    download: v.download === true,
    localshare: v.localshare === true,
  };
}
export async function readJSON(
  req: IncomingMessage,
  limit = 2 * 1024 * 1024,
): Promise<any> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "请求内容过大");
    parts.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString());
  } catch {
    throw new HttpError(400, "JSON 无效");
  }
}
export function reply(res: ServerResponse, status: number, body?: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
interface IncomingSession {
  transfer: Transfer;
  ip: string;
  peerCert?: string;
  root: string;
  tokens: Map<string, string>;
  active: Set<string>;
  abort: AbortController;
  answer?: (yes: boolean) => void;
  expires: ReturnType<typeof setTimeout>;
}
interface OutgoingSession {
  transfer: Transfer;
  abort: AbortController;
  device: Device;
  remoteId?: string;
}
export interface ServiceOptions {
  dataDir: string;
  receiveDir: string;
  alias: string;
  port?: number;
  discovery?: boolean;
}
export class LocalShareService extends EventEmitter {
  identity!: Identity;
  info!: DeviceInfo;
  receiveDir: string;
  readonly devices = new Map<string, Device>();
  private transfers: Transfer[] = [];
  private server?: https.Server;
  private discovery?: Discovery;
  private incoming = new Map<string, IncomingSession>();
  private outgoing = new Map<string, OutgoingSession>();
  private probing = new Set<string>();
  private lastProbe = new Map<string, number>();
  private cleanup?: ReturnType<typeof setInterval>;
  private networkError?: string;
  private persist: Promise<void> = Promise.resolve();
  extensionHandler?: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ) => Promise<boolean>;
  extensionSnapshot: Snapshot["extensions"] = {
    trusted: [],
    pairing: [],
    control: { mode: "local" },
    clipboardEnabled: false,
    controlEnabled: false,
  };
  constructor(readonly options: ServiceOptions) {
    super();
    this.receiveDir = options.receiveDir;
  }
  async start() {
    this.identity = await loadIdentity(this.options.dataDir);
    await mkdir(this.receiveDir, { recursive: true });
    try {
      const history = JSON.parse(
        await readFile(join(this.options.dataDir, "history.json"), "utf8"),
      ) as Transfer[];
      this.transfers = history
        .slice(-200)
        .map((t) =>
          ["pending", "transferring"].includes(t.status)
            ? { ...t, status: "failed", error: "应用在传输完成前关闭" }
            : t,
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        this.networkError = "历史记录读取失败";
    }
    this.info = {
      alias: this.options.alias,
      version: "2.2",
      deviceModel:
        platform() === "darwin"
          ? "macOS"
          : platform() === "win32"
            ? "Windows"
            : "Linux",
      deviceType: "desktop",
      fingerprint: this.identity.fingerprint,
      port: this.options.port ?? 53317,
      protocol: "https",
      download: false,
      localshare: true,
    };
    this.server = https.createServer(
      {
        cert: this.identity.cert,
        key: this.identity.key,
        requestCert: true,
        rejectUnauthorized: false,
      },
      (req, res) => {
        void this.route(req, res).catch((e) =>
          reply(res, e instanceof HttpError ? e.status : 500, {
            error: e.message,
          }),
        );
      },
    );
    this.server.headersTimeout = 15000;
    this.server.requestTimeout = 0;
    this.server.maxConnections = 64;
    this.server.on("tlsClientError", () => {});
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.info.port, "0.0.0.0", () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });
    this.server.on("error", (e) => {
      this.networkError = e.message;
      this.changed();
    });
    this.info.port = (this.server.address() as { port: number }).port;
    if (this.options.discovery !== false) {
      this.discovery = new Discovery(
        () => this.info,
        async (value, ip) => {
          const candidate = deviceInfo(value);
          if (candidate.fingerprint === this.info.fingerprint) return;
          const known = this.devices.get(candidate.fingerprint);
          if (known && Date.now() - known.lastSeen < 5000) return;
          const key = `${ip}:${candidate.port}`;
          if (
            this.probing.has(key) ||
            Date.now() - (this.lastProbe.get(key) ?? 0) < 5000 ||
            this.probing.size >= 16
          )
            return;
          this.lastProbe.set(key, Date.now());
          this.probing.add(key);
          try {
            await this.register(
              ip,
              candidate.port,
              candidate.protocol,
              candidate.protocol === "https"
                ? candidate.fingerprint
                : undefined,
            );
          } finally {
            this.probing.delete(key);
          }
        },
        (e) => {
          this.networkError = `自动发现：${e.message}。可使用 IP 手动连接。`;
          this.changed();
        },
      );
      await this.discovery.start().catch((e) => {
        this.networkError = `自动发现不可用：${e.message}`;
      });
    }
    this.cleanup = setInterval(() => {
      let changed = false;
      for (const [id, d] of this.devices)
        if (Date.now() - d.lastSeen > 45000) {
          this.devices.delete(id);
          changed = true;
        }
      for (const [key, time] of this.lastProbe)
        if (Date.now() - time > 60000) this.lastProbe.delete(key);
      if (changed) this.changed();
    }, 10000);
    this.cleanup.unref();
    this.changed();
  }
  snapshot(): Snapshot {
    return structuredClone({
      info: this.info,
      addresses: addresses(),
      devices: [...this.devices.values()],
      transfers: this.transfers,
      receiveDir: this.receiveDir,
      networkError: this.networkError,
      extensions: this.extensionSnapshot,
    });
  }
  changed() {
    this.emit("change");
  }
  private record() {
    let retainedFiles = 0,
      retainedRecords = 0;
    this.transfers = this.transfers
      .toReversed()
      .filter((t) => {
        if (["pending", "transferring"].includes(t.status)) return true;
        if (retainedRecords >= 200 || retainedFiles + t.files.length > 20000)
          return false;
        retainedRecords++;
        retainedFiles += t.files.length;
        return true;
      })
      .reverse();
    const data = JSON.stringify(this.transfers.slice(-200));
    this.persist = this.persist
      .then(() =>
        atomicJSON(
          join(this.options.dataDir, "history.json"),
          JSON.parse(data),
        ),
      )
      .catch((e) => {
        this.networkError = `历史记录保存失败：${e.message}`;
        this.changed();
      });
    this.changed();
  }
  private touch(t: Transfer) {
    t.updatedAt = Date.now();
    this.changed();
  }
  private peerCertificate(req: IncomingMessage) {
    const cert = (req.socket as TLSSocket).getPeerCertificate?.();
    return cert?.raw ? fingerprint(cert.raw) : undefined;
  }
  private confirmInfo(req: IncomingMessage, value: unknown): Device {
    const info = deviceInfo(value);
    const actual = this.peerCertificate(req);
    if (actual && info.protocol === "https" && info.fingerprint !== actual)
      throw new HttpError(403, "发送方证书指纹不符");
    const d = {
      ...info,
      fingerprint: actual ?? info.fingerprint,
      ip: ipOf(req),
      lastSeen: Date.now(),
    };
    if (d.fingerprint !== this.info.fingerprint) {
      if (this.devices.size < 256 || this.devices.has(d.fingerprint))
        this.devices.set(d.fingerprint, d);
      this.changed();
    }
    return d;
  }
  async register(
    ip: string,
    port = 53317,
    protocol: "https" | "http" = "https",
    expected?: string,
  ): Promise<Device> {
    const { isIP } = await import("node:net");
    if (!isIP(ip) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("请输入有效的 IP 地址和端口");
    const response = await request(
      this.identity,
      { ip, port, protocol, fingerprint: expected },
      `${PREFIX}/register`,
      { json: this.info, timeout: 8000 },
    );
    const info = deviceInfo({
      ...jsonReply<DeviceInfo>(response),
      port,
      protocol,
    });
    if (response.fingerprint) info.fingerprint = response.fingerprint;
    const d = { ...info, ip, lastSeen: Date.now() };
    if (d.fingerprint !== this.info.fingerprint)
      this.devices.set(d.fingerprint, d);
    this.changed();
    return d;
  }
  discover() {
    this.discovery?.announce();
  }
  updateAlias(alias: string) {
    if (!alias.trim() || alias.length > 100)
      throw new Error("设备名称需要 1–100 个字符");
    this.info.alias = alias.trim();
    this.discover();
    this.changed();
  }
  async updateReceiveDir(dir: string) {
    await mkdir(dir, { recursive: true });
    this.receiveDir = dir;
    this.changed();
  }
  respond(id: string, accept: boolean) {
    this.incoming.get(id)?.answer?.(accept);
  }
  cancel(id: string) {
    const outgoing = this.outgoing.get(id);
    if (outgoing) {
      outgoing.transfer.status = "cancelled";
      outgoing.abort.abort();
      if (outgoing.remoteId)
        void request(
          this.identity,
          outgoing.device,
          `${PREFIX}/cancel?sessionId=${encodeURIComponent(outgoing.remoteId)}`,
          { timeout: 5000 },
        ).catch(() => {});
      this.record();
    }
    const incoming = this.incoming.get(id);
    if (incoming) {
      incoming.transfer.status = "cancelled";
      incoming.answer?.(false);
      incoming.abort.abort();
      this.finishIncoming(incoming);
    }
  }
  private finishIncoming(s: IncomingSession) {
    clearTimeout(s.expires);
    this.incoming.delete(s.transfer.id);
    if (s.transfer.files.every((f) => f.status !== "completed")) {
      // Wait for active streams to finish cleaning temporary files before removing their directory.
      if (!s.active.size)
        void rm(s.root, { recursive: true, force: true }).catch(() => {});
    }
    this.record();
  }
  private async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "https://localshare");
    if (
      url.pathname.startsWith("/api/localshare/") &&
      this.extensionHandler &&
      (await this.extensionHandler(req, res, url))
    )
      return;
    if (req.method === "GET" && url.pathname === `${PREFIX}/info`)
      return reply(res, 200, this.info);
    if (req.method !== "POST") return reply(res, 405);
    if (url.pathname === `${PREFIX}/register`) {
      this.confirmInfo(req, await readJSON(req, 16384));
      return reply(res, 200, this.info);
    }
    if (url.pathname === `${PREFIX}/prepare-upload`)
      return this.prepare(req, res);
    if (url.pathname === `${PREFIX}/upload`) return this.upload(req, res, url);
    if (url.pathname === `${PREFIX}/cancel`) {
      const s = this.incoming.get(url.searchParams.get("sessionId") ?? "");
      if (
        !s ||
        s.ip !== ipOf(req) ||
        (s.peerCert && s.peerCert !== this.peerCertificate(req))
      )
        return reply(res, 403);
      this.cancel(s.transfer.id);
      return reply(res, 200);
    }
    reply(res, 404);
  }
  private async prepare(req: IncomingMessage, res: ServerResponse) {
    if (this.incoming.size >= 4) throw new HttpError(409, "接收队列已满");
    const data = await readJSON(req);
    const peer = this.confirmInfo(req, data.info);
    if (
      !data.files ||
      typeof data.files !== "object" ||
      Array.isArray(data.files)
    )
      throw new HttpError(400, "文件列表无效");
    const entries = Object.entries(data.files);
    if (!entries.length || entries.length > 10000)
      throw new HttpError(400, "文件数量无效");
    const files: FileMeta[] = entries.map(([key, value]) => {
      const f = value as FileMeta;
      if (
        !f ||
        f.id !== key ||
        key.length > 128 ||
        !key ||
        !Number.isSafeInteger(f.size) ||
        f.size < 0 ||
        typeof f.fileType !== "string" ||
        f.fileType.length > 200 ||
        (f.sha256 != null &&
          (typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(f.sha256)))
      )
        throw new HttpError(400, "文件元信息无效");
      try {
        safeRelative(f.fileName);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      return {
        id: key,
        fileName: f.fileName,
        size: f.size,
        fileType: f.fileType,
        sha256: f.sha256,
      };
    });
    const total = files.reduce((sum, f) => sum + f.size, 0);
    if (!Number.isSafeInteger(total))
      throw new HttpError(400, "总文件大小无效");
    // Body parsing yields to other requests; enforce capacity again immediately
    // before reserving a slot, with no await between the check and insertion.
    if (this.incoming.size >= 4) throw new HttpError(409, "接收队列已满");
    const t: Transfer = {
      id: randomUUID(),
      direction: "receive",
      peer: peer.alias,
      peerFingerprint: peer.fingerprint,
      files: files.map((f) => ({ ...f, bytes: 0, status: "pending" })),
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const s: IncomingSession = {
      transfer: t,
      ip: ipOf(req),
      peerCert: this.peerCertificate(req),
      root: join(this.receiveDir, t.id),
      tokens: new Map(
        files.map((f) => [f.id, randomBytes(32).toString("hex")]),
      ),
      active: new Set(),
      abort: new AbortController(),
      expires: setTimeout(() => this.cancel(t.id), 90000),
    };
    this.incoming.set(t.id, s);
    this.transfers.push(t);
    res.once("close", () => {
      if (!res.writableEnded && this.incoming.has(t.id)) this.cancel(t.id);
    });
    const accepted = await new Promise<boolean>((resolve) => {
      s.answer = resolve;
      this.record();
      this.emit("incoming", structuredClone(t));
    });
    s.answer = undefined;
    if (!accepted || s.abort.signal.aborted) {
      if (t.status !== "cancelled") t.status = "rejected";
      this.finishIncoming(s);
      return reply(res, 403, { error: "对方拒绝了请求" });
    }
    try {
      await mkdir(s.root, { mode: 0o700 });
    } catch (e) {
      t.status = "failed";
      t.error = (e as Error).message;
      this.finishIncoming(s);
      throw e;
    }
    t.status = "transferring";
    t.updatedAt = Date.now();
    this.record();
    clearTimeout(s.expires);
    s.expires = setInterval(() => {
      if (Date.now() - t.updatedAt > 120000) this.cancel(t.id);
    }, 10000);
    s.expires.unref();
    reply(res, 200, { sessionId: t.id, files: Object.fromEntries(s.tokens) });
  }
  private async upload(req: IncomingMessage, res: ServerResponse, url: URL) {
    const id = url.searchParams.get("sessionId");
    const fileId = url.searchParams.get("fileId");
    const token = url.searchParams.get("token");
    if (!id || !fileId || !token) throw new HttpError(400, "缺少上传参数");
    const s = this.incoming.get(id);
    if (
      !s ||
      s.transfer.status !== "transferring" ||
      s.ip !== ipOf(req) ||
      s.tokens.get(fileId) !== token ||
      (s.peerCert && s.peerCert !== this.peerCertificate(req))
    )
      throw new HttpError(403, "上传令牌或设备身份无效");
    const f = s.transfer.files.find((f) => f.id === fileId)!;
    if (s.active.has(fileId) || f.status !== "pending")
      throw new HttpError(409, "文件已在传输或已完成");
    s.active.add(fileId);
    f.status = "transferring";
    this.touch(s.transfer);
    try {
      f.savedPath = await receiveFile({
        root: s.root,
        name: f.fileName,
        stream: req,
        size: f.size,
        sha256: f.sha256,
        signal: s.abort.signal,
        progress: (bytes) => {
          f.bytes = bytes;
          this.touch(s.transfer);
        },
      });
      f.status = "completed";
      s.tokens.delete(fileId);
      reply(res, 200);
      if (s.transfer.files.every((f) => f.status === "completed")) {
        s.transfer.status = "completed";
        this.finishIncoming(s);
      } else this.record();
    } catch (e) {
      f.status = "failed";
      if (!s.abort.signal.aborted) s.transfer.status = "failed";
      s.transfer.error = (e as Error).message;
      s.abort.abort();
      reply(res, /SHA-256|长度|大小/.test((e as Error).message) ? 422 : 500, {
        error: (e as Error).message,
      });
      this.finishIncoming(s);
    } finally {
      s.active.delete(fileId);
      if (
        !s.active.size &&
        !s.transfer.files.some((f) => f.status === "completed") &&
        ["failed", "cancelled"].includes(s.transfer.status)
      )
        await rm(s.root, { recursive: true, force: true }).catch(() => {});
    }
  }
  async send(
    fingerprint: string,
    sources: Source[],
    pin?: string,
  ): Promise<Transfer> {
    const device = this.devices.get(fingerprint);
    if (!device) throw new Error("设备已离线，请刷新后重试");
    if (!sources.length || sources.length > 10000)
      throw new Error("请选择 1–10000 个文件");
    const metas: FileMeta[] = [];
    for (const source of sources) {
      safeRelative(source.name);
      metas.push({
        id: randomUUID(),
        fileName: source.name,
        fileType: source.name.endsWith(".txt")
          ? "text/plain"
          : "application/octet-stream",
        ...(await hashSource(source)),
      });
    }
    const t: Transfer = {
      id: randomUUID(),
      direction: "send",
      peer: device.alias,
      peerFingerprint: fingerprint,
      files: metas.map((f) => ({ ...f, bytes: 0, status: "pending" })),
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const s: OutgoingSession = {
      transfer: t,
      abort: new AbortController(),
      device,
    };
    this.outgoing.set(t.id, s);
    this.transfers.push(t);
    this.record();
    try {
      const preparation = await request(
        this.identity,
        device,
        `${PREFIX}/prepare-upload${pin ? `?pin=${encodeURIComponent(pin)}` : ""}`,
        {
          json: {
            info: this.info,
            files: Object.fromEntries(metas.map((f) => [f.id, f])),
          },
          signal: s.abort.signal,
        },
      );
      if (preparation.status === 204) {
        t.status = "completed";
        return t;
      }
      const prepared = jsonReply<{
        sessionId: string;
        files: Record<string, string>;
      }>(preparation);
      if (
        typeof prepared.sessionId !== "string" ||
        !prepared.files ||
        typeof prepared.files !== "object"
      )
        throw new Error("对方返回了无效会话");
      s.remoteId = prepared.sessionId;
      t.status = "transferring";
      this.touch(t);
      let acceptedCount = 0;
      for (let i = 0; i < metas.length; i++) {
        const f = t.files[i];
        const token = prepared.files[f.id];
        if (!token) {
          f.status = "failed";
          continue;
        }
        acceptedCount++;
        f.status = "transferring";
        const source = sources[i];
        const input = source.data
          ? Readable.from([source.data])
          : createReadStream(source.path!);
        const meter = new Transform({
          transform: (chunk, _, cb) => {
            f.bytes += chunk.length;
            this.touch(t);
            cb(null, chunk);
          },
        });
        input.on("error", (e) => meter.destroy(e));
        meter.once("close", () => input.destroy());
        const q = new URLSearchParams({
          sessionId: prepared.sessionId,
          fileId: f.id,
          token,
        });
        const response = await request(
          this.identity,
          device,
          `${PREFIX}/upload?${q}`,
          {
            stream: input.pipe(meter),
            size: f.size,
            signal: s.abort.signal,
            timeout: 30000,
          },
        );
        if (response.status !== 200)
          throw new HttpError(response.status, response.body.toString());
        f.status = "completed";
        this.record();
      }
      if (!acceptedCount) throw new Error("对方没有接受任何文件");
      t.status = "completed";
      if (acceptedCount !== sources.length) t.error = "对方仅接收了部分文件";
    } catch (e) {
      const error = e as Error;
      t.status = s.abort.signal.aborted
        ? "cancelled"
        : e instanceof HttpError && e.status === 403
          ? "rejected"
          : "failed";
      t.error =
        e instanceof HttpError && e.status === 401
          ? "对方需要接收 PIN，请填写后重试"
          : error.message;
      if (s.remoteId)
        void request(
          this.identity,
          device,
          `${PREFIX}/cancel?sessionId=${encodeURIComponent(s.remoteId)}`,
          { timeout: 5000 },
        ).catch(() => {});
    } finally {
      this.outgoing.delete(t.id);
      t.updatedAt = Date.now();
      this.record();
    }
    return structuredClone(t);
  }
  clearHistory() {
    this.transfers = this.transfers.filter((t) =>
      ["pending", "transferring"].includes(t.status),
    );
    this.record();
  }
  async stop() {
    this.discovery?.stop();
    clearInterval(this.cleanup);
    for (const id of [...this.incoming.keys(), ...this.outgoing.keys()])
      this.cancel(id);
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((r) => this.server!.close(() => r()));
    }
    await this.persist;
  }
}
