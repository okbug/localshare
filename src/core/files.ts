import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  lstat,
  readdir,
  link,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Source } from "../shared/types";

export function safeRelative(name: unknown): string {
  if (
    typeof name !== "string" ||
    !name ||
    Buffer.byteLength(name) > 2048 ||
    /[\\\x00-\x1f<>:"|?*]/.test(name)
  )
    throw new Error("文件名无效");
  const parts = name.split("/");
  if (
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    )
  )
    throw new Error("不安全的文件路径");
  if (parts.some((p) => Buffer.byteLength(p) > 240))
    throw new Error("文件名过长");
  return name;
}
export async function collectSources(paths: string[]): Promise<Source[]> {
  const result: Source[] = [];
  async function walk(path: string, name: string) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of await readdir(path))
        await walk(join(path, entry), `${name}/${entry}`);
    } else if (stat.isFile()) {
      safeRelative(name);
      result.push({ name, path });
    }
    if (result.length > 10000) throw new Error("一次最多传输 10000 个文件");
  }
  for (const path of paths) await walk(path, basename(path));
  if (!result.length)
    throw new Error("没有可发送的文件；空目录和符号链接会被跳过");
  return result;
}
export async function hashSource(
  source: Source,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  if (source.data) {
    hash.update(source.data);
    size = source.data.length;
  } else {
    if (!source.path || !(await lstat(source.path)).isFile())
      throw new Error("源文件不存在或不是普通文件");
    for await (const chunk of createReadStream(source.path)) {
      size += chunk.length;
      hash.update(chunk);
    }
  }
  return { size, sha256: hash.digest("hex") };
}
export async function receiveFile(options: {
  root: string;
  name: string;
  stream: Readable;
  size: number;
  sha256?: string | null;
  signal: AbortSignal;
  progress: (n: number) => void;
}): Promise<string> {
  const name = safeRelative(options.name);
  const parts = name.split("/");
  let directory = options.root;
  const rootStat = await lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("接收目录不安全");
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part);
    await mkdir(directory, { mode: 0o700 }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("目录包含符号链接");
  }
  const temp = join(directory, `.localshare-${randomUUID()}.part`);
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    const meter = new Transform({
      transform(chunk, _, cb) {
        bytes += chunk.length;
        if (bytes > options.size) return cb(new Error("接收大小超过声明"));
        hash.update(chunk);
        options.progress(bytes);
        cb(null, chunk);
      },
    });
    await pipeline(
      options.stream,
      meter,
      createWriteStream(temp, { flags: "wx", mode: 0o600 }),
      { signal: options.signal },
    );
    if (bytes !== options.size) throw new Error("文件长度不符");
    if (
      options.sha256 &&
      hash.digest("hex").toLowerCase() !== options.sha256.toLowerCase()
    )
      throw new Error("SHA-256 校验失败");
    let target = join(directory, parts.at(-1)!);
    for (let i = 0; ; i++) {
      try {
        await link(temp, target);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || i > 999) throw e;
        target = join(directory, `${parts.at(-1)} (${i + 1})`);
      }
    }
    await unlink(temp);
    return target;
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e;
  }
}
export async function atomicJSON(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await (await import("node:fs/promises")).rename(temp, path);
}
