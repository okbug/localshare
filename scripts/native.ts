import { mkdir } from "node:fs/promises";
await mkdir("native/bin", { recursive: true });
const command =
  process.platform === "darwin"
    ? [
        "clang",
        "-O2",
        "-fobjc-arc",
        "native/macos.m",
        "-o",
        "native/bin/localshare-input",
        "-framework",
        "Foundation",
        "-framework",
        "ApplicationServices",
      ]
    : process.platform === "win32"
      ? [
          "cl.exe",
          "/nologo",
          "/EHsc",
          "/std:c++17",
          "/O2",
          "native/windows.cpp",
          "/Fe:native/bin/localshare-input.exe",
          "/Fo:native/bin/localshare-input.obj",
          "/link",
          "user32.lib",
        ]
      : undefined;
if (!command) {
  console.log("Native input helper is available for macOS and Windows only.");
  process.exit(0);
}
const result = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
process.exit(await result.exited);
