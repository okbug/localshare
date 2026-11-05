import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("physical multi-monitor geometry traverses seams and respects exterior portals", () => {
  const directory = mkdtempSync(join(tmpdir(), "localshare-geometry-"));
  const windows = process.platform === "win32";
  const binary = join(directory, windows ? "geometry.exe" : "geometry");
  try {
    execFileSync(
      windows ? "cl.exe" : "clang++",
      windows
        ? [
            "/nologo",
            "/EHsc",
            "/std:c++17",
            "native/display-geometry-test.cpp",
            `/Fe:${binary}`,
            `/Fo:${join(directory, "geometry.obj")}`,
          ]
        : [
            "-std=c++17",
            "-Wall",
            "-Wextra",
            "-pedantic",
            "native/display-geometry-test.cpp",
            "-o",
            binary,
          ],
      { encoding: "utf8", timeout: 60000 },
    );
    assert.match(
      execFileSync(binary, { encoding: "utf8", timeout: 10000 }),
      /display geometry tests passed/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
