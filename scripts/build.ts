import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { mkdir } from "node:fs/promises";
await import("./icon");
await mkdir("dist/main", { recursive: true });
await Promise.all([
  build({
    entryPoints: ["scripts/mac-signature.ts"],
    outfile: "dist/tools/mac-signature.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
  }),
  build({
    entryPoints: ["src/main/index.ts"],
    outfile: "dist/main/index.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    sourcemap: true,
  }),
  build({
    entryPoints: ["src/preload/control-panel.ts"],
    outfile: "dist/preload/control-panel.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    entryPoints: ["src/preload/index.ts"],
    outfile: "dist/preload/index.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  viteBuild(),
]);
const native = Bun.spawn(["bun", "scripts/native.ts"], {
  stdout: "inherit",
  stderr: "inherit",
});
if (await native.exited) process.exit(1);
