import https from "node:https";
import http from "node:http";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { Readable } from "node:stream";
import { fingerprint, type Identity } from "./identity";
export interface Endpoint {
  ip: string;
  port: number;
  protocol: "https" | "http";
  fingerprint?: string;
}
export interface Reply {
  status: number;
  body: Buffer;
  fingerprint?: string;
}
export async function request(
  identity: Identity,
  target: Endpoint,
  path: string,
  options: {
    method?: string;
    json?: unknown;
    stream?: Readable;
    size?: number;
    signal?: AbortSignal;
    timeout?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<Reply> {
  let actual: string | undefined;
  const agent =
    target.protocol === "https"
      ? new https.Agent({ keepAlive: false })
      : undefined;
  if (agent) {
    agent.createConnection = ((
      opts: tls.ConnectionOptions,
      callback: (error: Error | null, socket?: tls.TLSSocket) => void,
    ) => {
      const socket = tls.connect({
        ...opts,
        cert: identity.cert,
        key: identity.key,
        rejectUnauthorized: false,
      });
      let done = false;
      const finish = (error: Error | null) => {
        if (done) return;
        done = true;
        callback(error, error ? undefined : socket);
        if (error) socket.destroy();
      };
      socket.once("secureConnect", () => {
        try {
          const raw = socket.getPeerCertificate().raw;
          if (!raw) throw new Error("对方没有提供证书");
          actual = fingerprint(raw);
          const cert = new X509Certificate(raw);
          if (
            Date.now() < Date.parse(cert.validFrom) ||
            Date.now() > Date.parse(cert.validTo)
          )
            throw new Error("对方证书已过期或尚未生效");
          if (target.fingerprint && actual !== target.fingerprint.toUpperCase())
            throw new Error("设备证书指纹不匹配，已停止连接");
          finish(null);
        } catch (e) {
          finish(e as Error);
        }
      });
      socket.once("error", finish);
      const timer = setTimeout(() => finish(new Error("TLS 连接超时")), 8000);
      socket.once("secureConnect", () => clearTimeout(timer));
      socket.once("close", () => clearTimeout(timer));
      return undefined;
    }) as typeof agent.createConnection;
  }
  const body =
    options.json === undefined
      ? undefined
      : Buffer.from(JSON.stringify(options.json));
  const source = body ? Readable.from([body]) : options.stream;
  const size = body?.length ?? options.size ?? 0;
  try {
    return await new Promise<Reply>((resolve, reject) => {
      const req = (target.protocol === "https" ? https : http).request(
        {
          hostname: target.ip,
          port: target.port,
          path,
          method: options.method ?? "POST",
          agent,
          signal: options.signal,
          headers: {
            "content-type":
              options.json === undefined
                ? "application/octet-stream"
                : "application/json",
            "content-length": String(size),
            ...options.headers,
          },
        },
        (res) => {
          const parts: Buffer[] = [];
          let length = 0;
          res.on("data", (chunk) => {
            length += chunk.length;
            if (length > 4 * 1024 * 1024) res.destroy(new Error("响应过大"));
            else parts.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 500,
              body: Buffer.concat(parts),
              fingerprint: actual,
            }),
          );
        },
      );
      req.on("error", reject);
      req.setTimeout(options.timeout ?? 120000, () =>
        req.destroy(new Error("设备响应超时")),
      );
      source?.on("error", (e) => req.destroy(e));
      req.once("close", () => source?.destroy());
      if (source) source.pipe(req);
      else req.end();
    });
  } finally {
    agent?.destroy();
  }
}
export function jsonReply<T>(reply: Reply): T {
  if (reply.status < 200 || reply.status >= 300) {
    let message = reply.body.toString();
    try {
      const payload = JSON.parse(message);
      if (typeof payload?.error === "string" && payload.error.trim())
        message = payload.error;
    } catch {
      /* Legacy peers may return plain-text error messages. */
    }
    throw new HttpError(
      reply.status,
      message.slice(0, 2000) || `HTTP ${reply.status}`,
    );
  }
  return JSON.parse(reply.body.toString()) as T;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
