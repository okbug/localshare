import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
// Optional macOS cross-build, with a pinned official Zig distribution. Normal
// Windows builds use MSVC through scripts/native.ts and need no Zig download.
if (process.platform !== "darwin")
  throw new Error("This helper cross-build script targets macOS hosts.");
const version = "0.14.1";
const root = resolve("test-results/toolchains");
await mkdir(root, { recursive: true });
await mkdir("native/bin", { recursive: true });
const indexProcess = Bun.spawn(
  [
    "curl",
    "--fail",
    "--silent",
    "--show-error",
    "--max-time",
    "30",
    "https://ziglang.org/download/index.json",
  ],
  { stdout: "pipe", stderr: "inherit" },
);
const index = JSON.parse(
  await new Response(indexProcess.stdout).text(),
) as Record<string, Record<string, { tarball: string; shasum: string }>>;
if (await indexProcess.exited)
  throw new Error("Official Zig index download failed");
const distro =
  index[version][`${process.arch === "arm64" ? "aarch64" : "x86_64"}-macos`];
const archive = join(root, `zig-${version}.tar.xz`);
if (!(await Bun.file(archive).exists())) {
  console.log(
    `Downloading official Zig ${version} for a Windows helper cross-build…`,
  );
  const download = Bun.spawn(
    [
      "curl",
      "--fail",
      "--location",
      "--show-error",
      "--max-time",
      "180",
      "--retry",
      "2",
      "--output",
      archive,
      distro.tarball,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (await download.exited)
    throw new Error("Official Zig archive download failed");
}
if (
  createHash("sha256")
    .update(await readFile(archive))
    .digest("hex") !== distro.shasum
)
  throw new Error("Official Zig archive checksum mismatch");
const dir = distro.tarball.split("/").at(-1)!.replace(".tar.xz", "");
const zig = join(root, dir, "zig");
if (!(await Bun.file(zig).exists())) {
  const extract = Bun.spawn(["tar", "-xf", archive, "-C", root], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await extract.exited) process.exit(1);
}
const compile = Bun.spawn(
  [
    zig,
    "c++",
    "-target",
    "x86_64-windows-gnu",
    "-std=c++17",
    "-O2",
    "-static",
    "native/windows.cpp",
    "-luser32",
    "-o",
    "native/bin/localshare-input.exe",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
process.exit(await compile.exited);
