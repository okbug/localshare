import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
// Original code-native brand mark. No downloaded art or external fonts.
const width = 1024,
  raw = Buffer.alloc((width * 4 + 1) * width);
for (let y = 0; y < width; y++)
  for (let x = 0; x < width; x++) {
    const dx = x - 511.5,
      dy = y - 511.5,
      ax = Math.abs(dx),
      ay = Math.abs(dy);
    const corner = Math.hypot(Math.max(0, ax - 276), Math.max(0, ay - 276));
    const inside = corner < 210 && ax < 486 && ay < 486;
    const radius = Math.hypot(dx, dy);
    const white =
      radius < 39 ||
      ([133, 235, 337].some((r) => Math.abs(radius - r) < 20) &&
        ax > radius * 0.39);
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    raw[offset] = white ? 250 : 29;
    raw[offset + 1] = white ? 253 : 107;
    raw[offset + 2] = white ? 248 : 81;
    raw[offset + 3] = inside ? 255 : 0;
  }
function crc(data: Buffer) {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type),
    length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0);
header.writeUInt32BE(width, 4);
header[8] = 8;
header[9] = 6;
await mkdir("assets", { recursive: true });
await writeFile(
  "assets/icon.png",
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
